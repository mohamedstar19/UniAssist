import type { Media } from "@prisma/client";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { config } from "../config.js";
import { fileBlock, isTransient, llmJson, llmText } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getFile } from "../lib/storage.js";
import { batchCourses, coursesForPrompt } from "./courses.js";

const MAX_PDF_PAGES = 80;
const CHUNK_CHARS = 1800;

/** Text extraction: pdf-parse for digital PDFs, Claude vision for images and scanned PDFs. */
async function extractText(media: Media, data: Buffer): Promise<string> {
  if (media.kind === "pdf") {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const result = await parser.getText({ first: MAX_PDF_PAGES });
      const text = result.pages.map((p) => `[p.${p.num}]\n${p.text}`).join("\n\n");
      const letters = text.replace(/\[p\.\d+\]|\s/g, "").length;
      if (letters / Math.max(1, result.pages.length) >= 100) return text;
    } finally {
      await parser.destroy();
    }
    // Scanned PDF: let the model read it.
    return transcribe(data, media.mimeType);
  }
  if (media.kind === "image") return transcribe(data, media.mimeType);
  if (media.mimeType.startsWith("text/")) return data.toString("utf8");
  return ""; // Word/PowerPoint: stored in the library, not indexed in the MVP
}

async function transcribe(data: Buffer, mimeType: string): Promise<string> {
  const block = fileBlock(data, mimeType);
  if (!block) return "";
  const { text } = await llmText({
    model: config.MODEL_FAST,
    system:
      "Transcribe all text in this document/image exactly, keeping its language (Arabic/English) and layout (questions, numbering, tables as plain text, formulas in plain text). Handwriting included. For PDFs, start each page with [p.N]. If there are diagrams, describe each in one line in [brackets]. Output only the transcription.",
    messages: [{ role: "user", content: [block, { type: "text", text: "Transcribe." }] }],
    maxTokens: 32000,
    effort: "low",
  });
  return text;
}

const MaterialSchema = z.object({
  courseId: z.string().nullable(),
  materialType: z.enum(["slides", "sheet", "assignment", "model_answer", "past_exam", "other"]),
  lectureNumber: z.number().int().nullable(),
  title: z.string(),
});

export function chunkText(text: string): { content: string; page: number | null }[] {
  const chunks: { content: string; page: number | null }[] = [];
  let page: number | null = null;
  let buf = "";
  let bufPage: number | null = null;
  const flush = () => {
    const t = buf.trim();
    if (t.length > 40) chunks.push({ content: t, page: bufPage });
    buf = "";
    bufPage = null;
  };
  for (const para of text.split(/\n{2,}|(?=\[p\.\d+\])/)) {
    const m = para.match(/^\[p\.(\d+)\]/);
    if (m) page = Number(m[1]);
    if (buf.length + para.length > CHUNK_CHARS) flush();
    if (bufPage === null) bufPage = page;
    if (para.length > CHUNK_CHARS) {
      for (let i = 0; i < para.length; i += CHUNK_CHARS) {
        buf = para.slice(i, i + CHUNK_CHARS);
        bufPage = page;
        flush();
      }
      continue;
    }
    buf += (buf ? "\n\n" : "") + para;
  }
  flush();
  return chunks;
}

/** Extract, file and index every unprocessed file of a message. Returns the extracted texts. */
export async function processMessageMedia(rawMessageId: string, messageText: string): Promise<{ media: Media; text: string }[]> {
  const items = await db.media.findMany({ where: { rawMessageId } });
  const out: { media: Media; text: string }[] = [];
  for (const media of items) {
    if (media.processedAt) {
      out.push({ media, text: media.extractedText ?? "" });
      continue;
    }
    try {
      const data = await getFile(media.storageKey);
      const text = (await extractText(media, data)).trim();
      const courses = await batchCourses(media.batchId);
      const { data: meta } = await llmJson({
        model: config.MODEL_FAST,
        system: prompt("material"),
        schema: MaterialSchema,
        content:
          `Courses:\n${coursesForPrompt(courses)}\n\nFile name: ${media.filename ?? "(none)"}\n` +
          `Message: ${messageText || "(none)"}\n\nFile text (start):\n${text.slice(0, 4000) || "(no text)"}`,
        maxTokens: 4000,
      });
      const courseId = courses.some((c) => c.id === meta.courseId) ? meta.courseId : null;
      const updated = await db.media.update({
        where: { id: media.id },
        data: {
          extractedText: text || null,
          courseId,
          materialType: meta.materialType,
          lectureNumber: meta.lectureNumber,
          title: meta.title,
          processedAt: new Date(),
        },
      });
      const chunks = chunkText(text);
      if (chunks.length) {
        await db.materialChunk.createMany({
          data: chunks.map((c, idx) => ({ mediaId: media.id, batchId: media.batchId, courseId, idx, page: c.page, content: c.content })),
        });
      }
      out.push({ media: updated, text });
    } catch (err) {
      if (isTransient(err)) throw err; // let the queue retry later
      logger.error({ err, mediaId: media.id }, "media processing failed");
      out.push({ media, text: "" });
    }
  }
  return out;
}
