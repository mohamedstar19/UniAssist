import { parseFeatures, parseReminderPrefs } from "../features.js";
import { db } from "../lib/db.js";
import { redis } from "../lib/redis.js";
import { endOfDay, endOfWeek, formatDue, localDateKey, localHour } from "../lib/time.js";
import { enqueueNotify } from "../queues.js";
import { esc, TYPE_LABEL } from "./format.js";

/** Runs hourly; sends the 8 AM digest ("what's due today and this week") once per batch per day. */
export async function sendDigests(now = new Date()): Promise<void> {
  const batches = await db.batch.findMany();
  for (const batch of batches) {
    const f = parseFeatures(batch.features);
    if (localHour(batch.timezone, now) !== f.digestHour) continue;
    const key = `digest:${batch.id}:${localDateKey(batch.timezone, now)}`;
    if (!(await redis.set(key, "1", "EX", 36 * 3600, "NX"))) continue;

    const events = await db.event.findMany({
      where: { batchId: batch.id, status: "active", dueAt: { gte: now, lte: endOfWeek(batch.timezone, now) }, type: { in: ["assignment", "quiz", "exam"] } },
      include: { course: true },
      orderBy: { dueAt: "asc" },
    });
    if (!events.length) continue;
    const todayEnd = endOfDay(batch.timezone, now);

    const students = await db.student.findMany({ where: { batchId: batch.id, acceptedTermsAt: { not: null } } });
    for (const s of students) {
      if (!parseReminderPrefs(s.reminderPrefs).digest) continue;
      const mine = events.filter((e) => !e.courseId || !s.mutedCourseIds.includes(e.courseId));
      if (!mine.length) continue;
      const today = mine.filter((e) => e.dueAt! <= todayEnd);
      const week = mine.filter((e) => e.dueAt! > todayEnd);
      const line = (e: (typeof mine)[number]) =>
        `• ${TYPE_LABEL[e.type]}${e.course ? ` <b>${esc(e.course.name)}</b>` : ""}: ${esc(e.title)} · ${formatDue(e.dueAt, batch.timezone)}`;
      const parts = ["☀️ <b>صباح الخير!</b>"];
      parts.push(today.length ? `\n<b>النهارده:</b>\n${today.map(line).join("\n")}` : "\nالنهارده فاضي 🎉");
      if (week.length) parts.push(`\n<b>الأسبوع ده:</b>\n${week.map(line).join("\n")}`);
      parts.push("\nذاكر بدري: /quiz أو /plan 💪");
      await enqueueNotify({ chatId: s.telegramId, text: parts.join("\n") });
    }
  }
}
