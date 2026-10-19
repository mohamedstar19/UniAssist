import type { Course, Event } from "@prisma/client";
import { formatDue, relativeFromNow } from "../lib/time.js";
import type { NotifyJob } from "../queues.js";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const TYPE_LABEL: Record<string, string> = {
  assignment: "📝 أسايمنت",
  quiz: "⏱️ كويز",
  exam: "🎯 امتحان",
  schedule_change: "🔁 تغيير",
  announcement: "📢 إعلان",
};

export type EventWithCourse = Event & { course: Course | null };

/** Fixed card format: course · type · due · what's required. */
export function eventCard(e: EventWithCourse, tz: string, opts: { header?: string; showRelative?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.header) lines.push(opts.header);
  lines.push(`<b>${TYPE_LABEL[e.type] ?? e.type}${e.course ? ` · ${esc(e.course.name)}` : ""}</b>`);
  lines.push(esc(e.title));
  if (e.type !== "announcement" || e.dueAt) {
    const rel = opts.showRelative && e.dueAt ? ` (${relativeFromNow(e.dueAt)})` : "";
    lines.push(`🗓️ ${formatDue(e.dueAt, tz)}${rel}`);
  }
  if (e.description) lines.push("", esc(e.description.length > 900 ? `${e.description.slice(0, 900)}…` : e.description));
  return lines.join("\n");
}

/** Study buttons shown under a card in a student's private chat. */
export function studyButtons(e: Event): NotifyJob["buttons"] {
  if (e.type === "assignment") {
    return [
      [
        { text: "📖 اشرحلي المطلوب", data: `t:explain:${e.id}` },
        { text: "💡 تلميح", data: `t:hint:${e.id}` },
      ],
      [{ text: "✍️ حلّه معايا خطوة بخطوة", data: `t:solve:${e.id}` }],
    ];
  }
  if (e.type === "quiz" || e.type === "exam") {
    return [
      [
        { text: "🧠 امتحني فيه", data: `q:ev:${e.id}` },
        { text: "📅 خطة مذاكرة", data: `t:plan:${e.id}` },
      ],
    ];
  }
  return undefined;
}

export function repButtons(eventId: string): NotifyJob["buttons"] {
  return [
    [
      { text: "✅ تأكيد", data: `ev:ok:${eventId}` },
      { text: "❌ مش حدث", data: `ev:no:${eventId}` },
    ],
    [{ text: "✏️ تعديل", data: `ev:edit:${eventId}` }],
  ];
}

/** Split long text into Telegram-sized messages (limit is 4096), breaking at paragraphs. */
export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Converts the assistant's light Markdown (``` fences, `code`, **bold**) to
 * Telegram HTML. Everything else is escaped.
 */
export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = nl > 0 ? part.slice(0, nl).trim() : "";
      const code = nl >= 0 && /^[\w+#.-]*$/.test(lang) ? part.slice(nl + 1) : part;
      const cls = lang && /^[\w+#.-]+$/.test(lang) ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${cls}>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    } else {
      out.push(
        esc(part)
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
          .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>"),
      );
    }
  });
  return out.join("");
}

/** Splits Markdown into Telegram-sized pieces without breaking a code fence. */
export function splitMarkdown(md: string, limit = 3500): string[] {
  const pieces = splitMessage(md, limit);
  let open: string | null = null;
  return pieces.map((p) => {
    let piece = open !== null ? "```" + open + "\n" + p : p;
    const fences = piece.match(/```[^\n]*/g) ?? [];
    open = null;
    let inside = false;
    let lang = "";
    for (const f of fences) {
      inside = !inside;
      if (inside) lang = f.slice(3).trim();
    }
    if (inside) {
      piece += "\n```";
      open = lang;
    }
    return piece;
  });
}
