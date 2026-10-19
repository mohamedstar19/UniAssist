import type { Student } from "@prisma/client";
import { parseReminderPrefs } from "../features.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { relativeFromNow } from "../lib/time.js";
import { enqueueNotify } from "../queues.js";
import { eventCard, studyButtons } from "./format.js";

const REMINDER_TYPES = new Set(["assignment", "quiz", "exam"]);
const MIN_LEAD_MS = 5 * 60 * 1000;

/** Planned reminder times for one student and one due date. */
export function reminderTimes(dueAt: Date, offsetsMinutes: number[], now = new Date()): Date[] {
  return [...new Set(offsetsMinutes)]
    .map((m) => new Date(dueAt.getTime() - m * 60_000))
    .filter((t) => t.getTime() > now.getTime() + MIN_LEAD_MS);
}

/**
 * (Re)builds the pending reminders of an event. Called whenever an event is
 * created, confirmed, changed or cancelled. Sent reminders are kept.
 */
export async function scheduleEventReminders(eventId: string): Promise<void> {
  await db.reminder.deleteMany({ where: { eventId, sentAt: null } });
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event || event.status !== "active" || !event.dueAt || !REMINDER_TYPES.has(event.type)) return;

  const students = await db.student.findMany({ where: { batchId: event.batchId, acceptedTermsAt: { not: null } } });
  const rows = students.flatMap((s) => remindersFor(s, event.id, event.dueAt!, event.courseId));
  if (rows.length) await db.reminder.createMany({ data: rows, skipDuplicates: true });
}

function remindersFor(s: Student, eventId: string, dueAt: Date, courseId: string | null) {
  if (courseId && s.mutedCourseIds.includes(courseId)) return [];
  const prefs = parseReminderPrefs(s.reminderPrefs);
  return reminderTimes(dueAt, prefs.offsetsMinutes).map((fireAt) => ({ eventId, studentId: s.id, fireAt }));
}

/** After a student changes their preferences or mutes a course, or joins. */
export async function rescheduleStudent(studentId: string): Promise<void> {
  const s = await db.student.findUnique({ where: { id: studentId } });
  if (!s) return;
  await db.reminder.deleteMany({ where: { studentId, sentAt: null } });
  if (!s.acceptedTermsAt) return;
  const events = await db.event.findMany({
    where: { batchId: s.batchId, status: "active", dueAt: { gt: new Date() }, type: { in: ["assignment", "quiz", "exam"] } },
  });
  const rows = events.flatMap((e) => remindersFor(s, e.id, e.dueAt!, e.courseId));
  if (rows.length) await db.reminder.createMany({ data: rows, skipDuplicates: true });
}

/** Runs every minute: queues the reminders that are due. */
export async function fireDueReminders(): Promise<number> {
  const due = await db.reminder.findMany({
    where: { sentAt: null, cancelled: false, fireAt: { lte: new Date() } },
    include: { student: { include: { batch: true } }, event: { include: { course: true } } },
    take: 500,
    orderBy: { fireAt: "asc" },
  });
  for (const r of due) {
    // Mark first: a reminder must never be sent twice. The notify job retries delivery itself.
    const claimed = await db.reminder.updateMany({ where: { id: r.id, sentAt: null }, data: { sentAt: new Date() } });
    if (claimed.count === 0) continue;
    const e = r.event;
    if (e.status !== "active" || !e.dueAt || e.dueAt < new Date()) continue;
    const tz = r.student.batch.timezone;
    const header = `⏰ <b>تذكير: ${relativeFromNow(e.dueAt)}</b>`;
    await enqueueNotify({
      chatId: r.student.telegramId,
      text: eventCard(e, tz, { header }),
      buttons: studyButtons(e),
      reminderId: r.id,
    });
  }
  if (due.length) logger.info({ count: due.length }, "reminders queued");
  return due.length;
}

