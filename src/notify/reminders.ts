import type { Student } from "@prisma/client";
import { DateTime } from "luxon";
import { parseReminderPrefs } from "../features.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_TZ, isPastDue, relativeFromNow, reminderAnchor } from "../lib/time.js";
import { enqueueNotify } from "../queues.js";
import { eventCard, studyButtons } from "./format.js";

const REMINDER_TYPES = new Set(["assignment", "quiz", "exam"]);
const MIN_LEAD_MS = 5 * 60 * 1000;

/** Planned reminder times for one student and one due date. */
export function reminderTimes(dueAt: Date, offsetsMinutes: number[], now = new Date(), tz = DEFAULT_TZ): Date[] {
  const anchor = reminderAnchor(dueAt, tz);
  const times = [...new Set(offsetsMinutes)]
    .map((m) => quietHours(new Date(anchor.getTime() - m * 60_000), tz))
    .filter((t) => t.getTime() > now.getTime() + MIN_LEAD_MS && t.getTime() < anchor.getTime());
  return [...new Map(times.map((t) => [t.getTime(), t])).values()].sort((a, b) => a.getTime() - b.getTime());
}

/** No reminders between midnight and 7 AM: those move to 10 PM the evening before. */
function quietHours(t: Date, tz: string): Date {
  const local = DateTime.fromJSDate(t, { zone: tz });
  return local.hour < 7 ? local.minus({ days: 1 }).set({ hour: 22, minute: 0, second: 0, millisecond: 0 }).toJSDate() : t;
}

/**
 * (Re)builds the pending reminders of an event. Called whenever an event is
 * created, confirmed, changed or cancelled. Sent reminders are kept.
 */
export async function scheduleEventReminders(eventId: string): Promise<void> {
  await db.reminder.deleteMany({ where: { eventId, sentAt: null } });
  const event = await db.event.findUnique({ where: { id: eventId }, include: { batch: true } });
  if (!event || event.status !== "active" || !event.dueAt || !REMINDER_TYPES.has(event.type)) return;
  const tz = event.batch.timezone;

  const students = await db.student.findMany({ where: { batchId: event.batchId, acceptedTermsAt: { not: null } } });
  const rows = students.flatMap((s) => remindersFor(s, event.id, event.dueAt!, event.courseId, tz));
  if (rows.length) await db.reminder.createMany({ data: rows, skipDuplicates: true });
}

function remindersFor(s: Student, eventId: string, dueAt: Date, courseId: string | null, tz: string) {
  if (courseId && s.mutedCourseIds.includes(courseId)) return [];
  const prefs = parseReminderPrefs(s.reminderPrefs);
  return reminderTimes(dueAt, prefs.offsetsMinutes, new Date(), tz).map((fireAt) => ({ eventId, studentId: s.id, fireAt }));
}

/** After a student changes their preferences or mutes a course, or joins. */
export async function rescheduleStudent(studentId: string): Promise<void> {
  const s = await db.student.findUnique({ where: { id: studentId }, include: { batch: true } });
  if (!s) return;
  await db.reminder.deleteMany({ where: { studentId, sentAt: null } });
  if (!s.acceptedTermsAt) return;
  const events = await db.event.findMany({
    where: { batchId: s.batchId, status: "active", dueAt: { gt: new Date(Date.now() - 86400_000) }, type: { in: ["assignment", "quiz", "exam"] } },
  });
  const rows = events.flatMap((e) => remindersFor(s, e.id, e.dueAt!, e.courseId, s.batch.timezone));
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
    const tz = r.student.batch.timezone;
    if (e.status !== "active" || !e.dueAt || isPastDue(e.dueAt, tz)) continue;
    const header = `⏰ <b>تذكير: ${relativeFromNow(e.dueAt, new Date(), tz)}</b>`;
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

