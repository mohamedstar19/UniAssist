import { config } from "../config.js";
import { db } from "../lib/db.js";
import { enqueueNotify } from "../queues.js";
import { esc } from "./format.js";

const TYPE_LABEL: Record<string, string> = {
  slides: "سلايدات",
  sheet: "شيت",
  assignment: "أسايمنت",
  model_answer: "إجابة نموذجية",
  past_exam: "امتحان قديم",
  other: "ملف",
};

export function materialLabel(t: string): string {
  return TYPE_LABEL[t] ?? "ملف";
}

/** Posts new study files to the batch channel (students aren't DMed for files: too noisy). */
export async function announceMaterial(batchId: string, mediaIds: string[]): Promise<void> {
  const batch = await db.batch.findUnique({ where: { id: batchId } });
  if (!batch?.channelId) return;
  const media = await db.media.findMany({ where: { id: { in: mediaIds } }, include: { course: true } });
  if (!media.length) return;
  const lines = ["📎 <b>ملفات جديدة في المكتبة</b>"];
  for (const m of media) {
    const url = `${config.PUBLIC_URL}/b/${batch.webToken}/f/${m.id}`;
    lines.push(`• ${m.course ? `${esc(m.course.name)} · ` : ""}${materialLabel(m.materialType)}${m.lectureNumber ? ` ${m.lectureNumber}` : ""}: <a href="${url}">${esc(m.title ?? m.filename ?? "ملف")}</a>`);
  }
  await enqueueNotify({ chatId: batch.channelId, text: lines.join("\n") });
}
