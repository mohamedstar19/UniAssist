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
export function relativeFromNow(d: Date | null | undefined, now = new Date(), tz = DEFAULT_TZ): string {
  if (!d) return "";
  if (isDayOnly(d, tz)) {
    const days = Math.round(DateTime.fromJSDate(d, { zone: tz }).startOf("day").diff(DateTime.fromJSDate(now, { zone: tz }).startOf("day"), "days").days);
    if (days < 0) return "فات";
    if (days === 0) return "النهارده";
    if (days === 1) return "بكرة";
    return `بعد ${days} يوم`;
  }
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

/**
 * When a message only gives the day ("الكويز يوم الأحد"), the due time is stored as 00:00 local.
 * Such events belong to the whole day: they are not "past" until the day ends, and reminders
 * are anchored at 08:00 that morning instead of midnight.
 */
export function isDayOnly(d: Date, tz = DEFAULT_TZ): boolean {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  return dt.hour === 0 && dt.minute === 0;
}

/** The moment after which the event is over. */
export function dueEnd(d: Date, tz = DEFAULT_TZ): Date {
  return isDayOnly(d, tz) ? DateTime.fromJSDate(d, { zone: tz }).endOf("day").toJSDate() : d;
}

export function isPastDue(d: Date, tz = DEFAULT_TZ, now = new Date()): boolean {
  return dueEnd(d, tz).getTime() < now.getTime();
}

/** The time reminders count back from. */
export function reminderAnchor(d: Date, tz = DEFAULT_TZ): Date {
  return isDayOnly(d, tz) ? DateTime.fromJSDate(d, { zone: tz }).set({ hour: 8 }).toJSDate() : d;
}
