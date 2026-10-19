import { bot } from "../bot/instance.js";
import { config } from "../config.js";
import { db } from "../lib/db.js";
import { enqueueNotify, type NotifyJob } from "../queues.js";
import { eventCard, esc, repButtons, studyButtons } from "./format.js";
import { scheduleEventReminders } from "./reminders.js";

export type AnnounceKind = "new" | "changed" | "cancelled";

const HEADERS: Record<AnnounceKind, string> = {
  new: "🆕 <b>جديد</b>",
  changed: "🔁 <b>اتغير</b>",
  cancelled: "🚫 <b>اتلغى</b>",
};

function deepLink(payload: string): string | undefined {
  try {
    return `https://t.me/${bot.botInfo.username}?start=${payload}`;
  } catch {
    return undefined; // bot.init() not called in this process
  }
}

/** Post an event to the batch channel and to every student (except those who muted the course). */
export async function announceEvent(eventId: string, kind: AnnounceKind, changeSummary?: string | null): Promise<void> {
  const event = await db.event.findUnique({ where: { id: eventId }, include: { course: true, batch: true } });
  if (!event) return;
  const tz = event.batch.timezone;
  const header = HEADERS[kind] + (changeSummary ? `\n${esc(changeSummary)}` : "");
  const text = eventCard(event, tz, { header, showRelative: kind !== "cancelled" });

  if (event.batch.channelId) {
    const link = deepLink(`ev_${event.id}`);
    await enqueueNotify({
      chatId: event.batch.channelId,
      text,
      buttons: link && kind !== "cancelled" ? [[{ text: "🤖 افتح في البوت", url: link }]] : undefined,
    });
  }

  const students = await db.student.findMany({ where: { batchId: event.batchId, acceptedTermsAt: { not: null } } });
  for (const s of students) {
    if (event.courseId && s.mutedCourseIds.includes(event.courseId)) continue;
    await enqueueNotify({ chatId: s.telegramId, text, buttons: kind === "cancelled" ? undefined : studyButtons(event) });
  }

  await db.event.update({ where: { id: event.id }, data: { notifiedAt: new Date() } });
  await scheduleEventReminders(event.id);
}

/** Reps of the batch; falls back to the admins when the batch has no rep yet. */
export async function repChatIds(batchId: string): Promise<string[]> {
  const reps = await db.student.findMany({ where: { batchId, role: "rep" }, select: { telegramId: true } });
  return reps.length ? reps.map((r) => r.telegramId) : config.ADMIN_TELEGRAM_IDS;
}

export async function notifyReps(batchId: string, text: string, buttons?: NotifyJob["buttons"]): Promise<void> {
  for (const chatId of await repChatIds(batchId)) await enqueueNotify({ chatId, text, buttons });
}

export async function askRepToConfirm(eventId: string, reason: string): Promise<void> {
  const event = await db.event.findUnique({ where: { id: eventId }, include: { course: true, batch: true, createdFromMessage: true } });
  if (!event) return;
  const source = event.createdFromMessage?.text
    ? `\n\n💬 الرسالة الأصلية${event.createdFromMessage.senderName ? ` (${esc(event.createdFromMessage.senderName)})` : ""}:\n<i>${esc(event.createdFromMessage.text.slice(0, 600))}</i>`
    : "";
  const text = eventCard(event, event.batch.timezone, { header: `🕵️ <b>محتاج تأكيدك قبل ما يتبعت للدفعة</b>\n${esc(reason)}` }) + source;
  await notifyReps(event.batchId, text, repButtons(event.id));
}
