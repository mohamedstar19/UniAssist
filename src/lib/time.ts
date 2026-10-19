import { DateTime } from "luxon";

export const DEFAULT_TZ = "Africa/Cairo";

function local(d: Date, tz: string): DateTime {
  return DateTime.fromJSDate(d, { zone: tz }).setLocale("ar-EG").reconfigure({ numberingSystem: "latn" });
}

/** "الأحد 22 أكتوبر · 2:00 م" */
export function formatDue(d: Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!d) return "الميعاد لسه مش محدد";
  const dt = local(d, tz);
  const hasTime = !(dt.hour === 0 && dt.minute === 0);
  return hasTime ? dt.toFormat("cccc d MMMM · h:mm a") : dt.toFormat("cccc d MMMM");
}

export function formatShortDate(d: Date, tz = DEFAULT_TZ): string {
  return local(d, tz).toFormat("d MMMM");
}

/** "بعد 3 أيام" / "بعد 5 ساعات" / "خلاص فات" */
export function relativeFromNow(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "";
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  if (mins < 0) return "فات";
  if (mins < 60) return `بعد ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `بعد ${hours} ساعة`;
  return `بعد ${Math.round(hours / 24)} يوم`;
}

export function startOfDay(tz: string, now = new Date()): Date {
  return DateTime.fromJSDate(now, { zone: tz }).startOf("day").toJSDate();
}

export function endOfDay(tz: string, now = new Date()): Date {
  return DateTime.fromJSDate(now, { zone: tz }).endOf("day").toJSDate();
}

export function endOfWeek(tz: string, now = new Date()): Date {
  return DateTime.fromJSDate(now, { zone: tz }).plus({ days: 7 }).endOf("day").toJSDate();
}

export function localHour(tz: string, now = new Date()): number {
  return DateTime.fromJSDate(now, { zone: tz }).hour;
}

export function localDateKey(tz: string, now = new Date()): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

/** "2026-10-19T14:00:00+03:00 (الإثنين)" for prompts */
export function promptDate(d: Date, tz = DEFAULT_TZ): string {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  return `${dt.toISO({ suppressMilliseconds: true })} (${dt.setLocale("en").toFormat("cccc")})`;
}
