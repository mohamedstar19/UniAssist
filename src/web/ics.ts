import type { Course, Event } from "@prisma/client";

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets must be folded (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > 73) {
      out.push(cur);
      cur = " " + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** Calendar feed so students can subscribe from Google/Apple Calendar. */
export function buildIcs(name: string, events: (Event & { course: Course | null })[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//UniAssist//AR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(name)}`];
  for (const e of events) {
    if (!e.dueAt) continue;
    const length = e.durationMinutes ?? (e.type === "exam" ? 180 : e.type === "quiz" ? 60 : 30);
    const start = e.type === "assignment" ? new Date(e.dueAt.getTime() - 30 * 60_000) : e.dueAt;
    const end = e.type === "assignment" ? e.dueAt : new Date(e.dueAt.getTime() + length * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@uniassist`,
      `DTSTAMP:${icsDate(e.updatedAt)}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      fold(`SUMMARY:${icsText(`${e.course ? `${e.course.name} - ` : ""}${e.title}`)}`),
      ...(e.description ? [fold(`DESCRIPTION:${icsText(e.description)}`)] : []),
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT3H", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
