import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { notifyQueue } from "../src/queues.js";
import type { ExtractItem } from "../src/pipeline/extract.js";
import { applyExtraction, resolveProposedChange } from "../src/pipeline/events.js";
import { activeExamLock } from "../src/tutor/guard.js";

/** Integration tests against a real Postgres + Redis (see vitest.config.ts). */

let batchId = "";
let courseId = "";
let groupId = "";
let studentId = "";
let mutedStudentId = "";
let repId = "";
let msgCounter = 0;

const DAY = 86400_000;

function item(over: Partial<ExtractItem>): ExtractItem {
  return {
    action: "create",
    targetEventId: null,
    type: "quiz",
    courseId,
    newCourseName: null,
    title: "Quiz 1",
    description: "",
    dueAt: new Date(Date.now() + 5 * DAY).toISOString(),
    needsDate: false,
    durationMinutes: null,
    changeSummary: null,
    confidence: 0.95,
    ...over,
  };
}

async function rawMessage(sender: string, text = "msg") {
  msgCounter += 1;
  return db.rawMessage.create({ data: { groupId, externalId: `m${msgCounter}`, senderHint: sender, text, sentAt: new Date() } });
}

async function wipe() {
  await db.$executeRawUnsafe(
    'TRUNCATE "Reminder","Correction","EventRevision","SolverJob","StudySession","Event","MaterialChunk","Media","RawMessage","Group","LectureSlot","Instructor","Student","Course","Batch","Faculty" CASCADE',
  );
}

beforeAll(async () => {
  await wipe();
});

afterAll(async () => {
  await notifyQueue.obliterate({ force: true });
  await notifyQueue.close();
  await redis.quit();
  await db.$disconnect();
});

beforeEach(async () => {
  await wipe();
  await notifyQueue.obliterate({ force: true });
  const faculty = await db.faculty.create({ data: { name: "Engineering", university: "Cairo" } });
  const batch = await db.batch.create({
    data: { facultyId: faculty.id, name: "Comm 3", year: 2026, inviteCode: "ABC123", webToken: "tok", features: { repConfirmAll: false } },
  });
  batchId = batch.id;
  const course = await db.course.create({ data: { batchId, name: "Physics", aliases: ["فيزيا"] } });
  courseId = course.id;
  await db.instructor.create({ data: { courseId, name: "Dr. Ali", phoneHint: "201011111111" } });
  groupId = (await db.group.create({ data: { source: "whatsapp", externalId: "g1", batchId } })).id;
  const terms = new Date();
  studentId = (await db.student.create({ data: { batchId, telegramId: "1", name: "A", acceptedTermsAt: terms } })).id;
  mutedStudentId = (await db.student.create({ data: { batchId, telegramId: "2", name: "B", mutedCourseIds: [courseId], acceptedTermsAt: terms } })).id;
  repId = (await db.student.create({ data: { batchId, telegramId: "3", name: "Rep", role: "rep", acceptedTermsAt: terms } })).id;
});

describe("applyExtraction", () => {
  it("creates an active event, notifies, and schedules reminders except for muted students", async () => {
    const msg = await rawMessage("201011111111");
    const [id] = await applyExtraction([item({})], { rawMessageId: msg.id, batchId, senderIsInstructor: true });
    const event = await db.event.findUniqueOrThrow({ where: { id: id! } });
    expect(event.status).toBe("active");
    expect(event.notifiedAt).not.toBeNull();

    const reminders = await db.reminder.findMany({ where: { eventId: event.id } });
    expect(reminders.length).toBe(3 * 2); // student + rep, 3 offsets each
    expect(reminders.some((r) => r.studentId === mutedStudentId)).toBe(false);

    const jobs = await notifyQueue.getJobs(["waiting", "delayed", "prioritized"]);
    expect(jobs.map((j) => j.data.chatId).sort()).toEqual(["1", "3"]);
  });

  it("treats a re-post of the same quiz (±1 day) as a duplicate", async () => {
    const m1 = await rawMessage("201099999999");
    const m2 = await rawMessage("201088888888");
    const due = Date.now() + 5 * DAY;
    await applyExtraction([item({ dueAt: new Date(due).toISOString() })], { rawMessageId: m1.id, batchId, senderIsInstructor: false });
    await applyExtraction([item({ dueAt: new Date(due + 3 * 3600_000).toISOString(), description: "chapters 1-3" })], {
      rawMessageId: m2.id,
      batchId,
      senderIsInstructor: false,
    });
    const events = await db.event.findMany({ where: { batchId } });
    expect(events.length).toBe(1);
    expect(events[0]!.description).toBe("chapters 1-3");
  });

  it("applies an instructor's date change as a revision of the same event", async () => {
    const m1 = await rawMessage("201011111111");
    const [id] = await applyExtraction([item({})], { rawMessageId: m1.id, batchId, senderIsInstructor: true });
    const newDue = new Date(Date.now() + 7 * DAY);
    const m2 = await rawMessage("201011111111", "الكويز اتأجل");
    await applyExtraction([item({ action: "update", targetEventId: id!, dueAt: newDue.toISOString(), changeSummary: "اتأجل" })], {
      rawMessageId: m2.id,
      batchId,
      senderIsInstructor: true,
    });
    const event = await db.event.findUniqueOrThrow({ where: { id: id! }, include: { revisions: true } });
    expect(event.dueAt!.getTime()).toBe(newDue.getTime());
    expect(event.revisions.map((r) => r.field)).toEqual(["dueAt"]);
    expect(await db.event.count()).toBe(1);
    const reminders = await db.reminder.findMany({ where: { eventId: id! } });
    expect(reminders.every((r) => r.fireAt.getTime() > Date.now() + 3 * DAY)).toBe(true);
  });

  it("sends a student's contradiction of an instructor to the rep instead of applying it", async () => {
    const m1 = await rawMessage("201011111111");
    const [id] = await applyExtraction([item({})], { rawMessageId: m1.id, batchId, senderIsInstructor: true });
    const before = await db.event.findUniqueOrThrow({ where: { id: id! } });
    const m2 = await rawMessage("201077777777", "لا الكويز يوم التلات");
    await notifyQueue.obliterate({ force: true });
    await applyExtraction([item({ action: "update", targetEventId: id!, dueAt: new Date(Date.now() + 9 * DAY).toISOString() })], {
      rawMessageId: m2.id,
      batchId,
      senderIsInstructor: false,
    });
    const after = await db.event.findUniqueOrThrow({ where: { id: id! } });
    expect(after.dueAt!.getTime()).toBe(before.dueAt!.getTime());

    const jobs = await notifyQueue.getJobs(["waiting", "delayed", "prioritized"]);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.data.chatId).toBe("3"); // the rep
    const data = jobs[0]!.data.buttons![0]![0]!.data!;
    const changeId = data.split(":")[2]!;
    expect(await resolveProposedChange(changeId, true)).toContain("اتطبق");
    const applied = await db.event.findUniqueOrThrow({ where: { id: id! } });
    expect(applied.dueAt!.getTime()).toBeGreaterThan(before.dueAt!.getTime());
  });

  it("holds low-confidence events for the rep", async () => {
    const m = await rawMessage("201055555555");
    const [id] = await applyExtraction([item({ confidence: 0.4 })], { rawMessageId: m.id, batchId, senderIsInstructor: false });
    const event = await db.event.findUniqueOrThrow({ where: { id: id! } });
    expect(event.status).toBe("pending");
    expect(await db.reminder.count({ where: { eventId: id! } })).toBe(0);
    const jobs = await notifyQueue.getJobs(["waiting"]);
    expect(jobs.map((j) => j.data.chatId)).toEqual(["3"]);
  });

  it("cancels an event and removes its pending reminders", async () => {
    const m1 = await rawMessage("201011111111");
    const [id] = await applyExtraction([item({})], { rawMessageId: m1.id, batchId, senderIsInstructor: true });
    const m2 = await rawMessage("201011111111", "الكويز اتلغى");
    await applyExtraction([item({ action: "cancel", targetEventId: id!, changeSummary: "الكويز اتلغى" })], {
      rawMessageId: m2.id,
      batchId,
      senderIsInstructor: true,
    });
    const event = await db.event.findUniqueOrThrow({ where: { id: id! } });
    expect(event.status).toBe("cancelled");
    expect(await db.reminder.count({ where: { eventId: id!, sentAt: null } })).toBe(0);
  });
});

describe("exam lock", () => {
  it("is on while a quiz of the batch is running", async () => {
    const batch = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(await activeExamLock(batch)).toBeNull();
    await db.event.create({
      data: { batchId, courseId, type: "quiz", title: "Quiz", dueAt: new Date(Date.now() - 10 * 60_000), status: "active", confidence: 1 },
    });
    const lock = await activeExamLock(batch);
    expect(lock?.event.title).toBe("Quiz");
  });
});

describe("material search (Postgres full-text)", () => {
  it("finds course material by Arabic or English words", async () => {
    const { searchMaterial } = await import("../src/tutor/retrieve.js");
    const media = await db.media.create({
      data: { batchId, courseId, kind: "pdf", mimeType: "application/pdf", storageKey: "x", sizeBytes: 1, materialType: "slides", lectureNumber: 4, title: "Lecture 4" },
    });
    await db.materialChunk.createMany({
      data: [
        { mediaId: media.id, batchId, courseId, idx: 0, page: 3, content: "Newton's second law: F = m a. القوة تساوي الكتلة في العجلة" },
        { mediaId: media.id, batchId, courseId, idx: 1, page: 9, content: "Ohm's law relates voltage and current: V = I R" },
      ],
    });
    const en = await searchMaterial(batchId, courseId, "explain newton second law", 5);
    expect(en[0]?.page).toBe(3);
    const ar = await searchMaterial(batchId, null, "يعني إيه الكتلة", 5);
    expect(ar[0]?.page).toBe(3);
    const none = await searchMaterial(batchId, courseId, "photosynthesis", 5);
    expect(none.length).toBe(0);
  });
});
