import { z } from "zod";
import { config } from "../config.js";
import { llmJson } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";
import { db } from "../lib/db.js";
import { promptDate } from "../lib/time.js";
import { announceEvent } from "../notify/announce.js";
import { scheduleEventReminders } from "../notify/reminders.js";
import { coursesForPrompt } from "./courses.js";
import { applyPatch, confirmEvent, type EventPatch } from "./events.js";

const CorrectionSchema = z.object({
  understood: z.boolean(),
  confirm: z.boolean(),
  reject: z.boolean(),
  cancel: z.boolean(),
  type: z.enum(["assignment", "quiz", "exam", "announcement"]).nullable(),
  dueAt: z.string().nullable(),
  courseId: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});

/**
 * The rep corrects an event in plain words ("ده مش كويز ده إعلان", "الميعاد الصح الخميس").
 * The correction is stored (for improving the prompts later) and applied.
 */
/** Who corrects: a rep (limited to their batch) or an admin (any batch). */
export interface CorrectionActor {
  studentId: string | null;
  batchId: string | null;
  adminTelegramId?: string | null;
}

export async function applyRepCorrection(actor: CorrectionActor, eventId: string, text: string): Promise<string> {
  const event = await db.event.findFirst({ where: { id: eventId, ...(actor.batchId ? { batchId: actor.batchId } : {}) }, include: { course: true, batch: true } });
  if (!event) return "مش لاقي الحدث ده.";
  const courses = await db.course.findMany({ where: { batchId: event.batchId } });
  const tz = event.batch.timezone;

  const { data: c } = await llmJson({
    model: config.MODEL_FAST,
    system: prompt("correction"),
    schema: CorrectionSchema,
    content:
      `Now (Cairo): ${promptDate(new Date(), tz)}\n\nCourses:\n${coursesForPrompt(courses)}\n\nEvent:\n` +
      JSON.stringify({ type: event.type, course: event.course?.name, title: event.title, description: event.description, dueAt: event.dueAt ? promptDate(event.dueAt, tz) : null, status: event.status }) +
      `\n\nRep message: """${text}"""`,
    maxTokens: 4000,
  });
  if (!c.understood) return "مفهمتش التعديل 🙏 قولها بشكل تاني، مثلاً: \"الميعاد الصح الخميس 2 الضهر\" أو \"ده إعلان مش كويز\".";

  const before = { type: event.type, dueAt: event.dueAt, courseId: event.courseId, title: event.title, status: event.status };
  const wasLive = event.status === "active" && !!event.notifiedAt;

  if (c.reject) {
    await applyPatch(eventId, { status: "rejected" });
    await scheduleEventReminders(eventId);
    await saveCorrection(actor, eventId, "reject", before, { status: "rejected" });
    if (wasLive) await announceEvent(eventId, "cancelled", "الخبر ده طلع غلط، اتشال من الأجندة.");
    return "🗑️ اتشال. مش هيتبعت للدفعة.";
  }
  if (c.cancel) {
    await applyPatch(eventId, { status: "cancelled" });
    await scheduleEventReminders(eventId);
    await saveCorrection(actor, eventId, "cancel", before, { status: "cancelled" });
    if (wasLive) await announceEvent(eventId, "cancelled", null);
    return "🚫 اتلغى وكل التنبيهات بتاعته اتشالت.";
  }

  const patch: EventPatch = {};
  if (c.type) patch.type = c.type;
  if (c.courseId && courses.some((x) => x.id === c.courseId)) patch.courseId = c.courseId;
  if (c.title) patch.title = c.title;
  if (c.description) patch.description = c.description;
  if (c.dueAt) {
    const d = new Date(c.dueAt);
    if (!Number.isNaN(d.getTime())) patch.dueAt = d;
  }

  const changed = await applyPatch(eventId, patch);
  if (changed.length) await saveCorrection(actor, eventId, "edit", before, patch);

  if (event.status === "pending") {
    // A correction on a pending event also confirms it.
    if (!event.dueAt && !patch.dueAt && event.type !== "announcement" && (patch.type ?? event.type) !== "announcement") {
      return "✏️ اتعدل. لسه محتاج الميعاد: ابعته، أو دوس ✅ تأكيد لو مفيش ميعاد.";
    }
    await confirmEvent(eventId);
    return "✅ اتعدل واتأكد واتبعت للدفعة.";
  }
  if (!changed.length) return c.confirm ? "👍 تمام." : "مفيش حاجة اتغيرت.";
  await scheduleEventReminders(eventId);
  if (wasLive && (changed.includes("dueAt") || changed.includes("type") || changed.includes("courseId"))) {
    await announceEvent(eventId, "changed", "تصحيح من مندوب الدفعة");
  }
  return `✅ اتعدل (${changed.join(", ")}).`;
}

async function saveCorrection(actor: CorrectionActor, eventId: string, action: string, before: unknown, after: unknown): Promise<void> {
  await db.correction.create({
    data: {
      studentId: actor.studentId,
      adminTelegramId: actor.adminTelegramId ?? null,
      eventId,
      action,
      before: JSON.parse(JSON.stringify(before)),
      after: JSON.parse(JSON.stringify(after)),
    },
  });
}
