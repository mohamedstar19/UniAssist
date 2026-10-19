import { randomBytes } from "node:crypto";
import { type Context, InlineKeyboard, InputFile } from "grammy";
import { config } from "../config.js";
import { db } from "../lib/db.js";
import { redis } from "../lib/redis.js";
import { mdToTelegramHtml, splitMarkdown } from "../notify/format.js";
import type { StudentWithBatch, UploadedFile } from "../tutor/tutor.js";
import { downloadTelegramFile } from "./instance.js";

export function isAdmin(ctx: Context): boolean {
  return !!ctx.from && config.ADMIN_TELEGRAM_IDS.includes(String(ctx.from.id));
}

export async function getStudent(ctx: Context): Promise<StudentWithBatch | null> {
  if (!ctx.from) return null;
  return db.student.findUnique({ where: { telegramId: String(ctx.from.id) }, include: { batch: true } });
}

export function isRep(s: StudentWithBatch | null): boolean {
  return s?.role === "rep";
}

/** Shows "typing…" while a slow task runs. */
export async function withTyping<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const tick = () => ctx.replyWithChatAction("typing").catch(() => undefined);
  await tick();
  const timer = setInterval(tick, 4500);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Sends a (possibly long) Markdown answer as Telegram HTML, with optional buttons on the last part. */
export async function sendAnswer(ctx: Context, md: string, keyboard?: InlineKeyboard): Promise<void> {
  const parts = splitMarkdown(md);
  const shown = parts.slice(0, 8);
  for (let i = 0; i < shown.length; i++) {
    const last = i === shown.length - 1;
    const markup = last && keyboard ? { reply_markup: keyboard } : {};
    try {
      await ctx.reply(mdToTelegramHtml(shown[i]!), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup });
    } catch {
      await ctx.reply(shown[i]!, markup); // formatting failed: send as plain text
    }
  }
  if (parts.length > shown.length) {
    await ctx.replyWithDocument(new InputFile(Buffer.from(md, "utf8"), "answer.md"), { caption: "الرد كامل في الملف ده 📄" });
  }
}

export function tutorKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🤔 اشرحها أبسط", "conv:simpler").text("✅ خلصت", "conv:end");
}

/** Files the student attached to this message (photo or document). */
export async function filesFromMessage(ctx: Context): Promise<UploadedFile[]> {
  const msg = ctx.message;
  if (!msg) return [];
  const files: UploadedFile[] = [];
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1]!;
    files.push({ data: await downloadTelegramFile(p.file_id), mimeType: "image/jpeg", name: "photo.jpg" });
  }
  if (msg.document && (msg.document.file_size ?? 0) <= 20 * 1024 * 1024) {
    files.push({
      data: await downloadTelegramFile(msg.document.file_id),
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      name: msg.document.file_name,
    });
  }
  return files;
}

/** A file waiting for the student to choose what to do with it. */
export async function stashFiles(studentId: string, ctx: Context): Promise<string | null> {
  const msg = ctx.message;
  if (!msg) return null;
  const refs: { fileId: string; mimeType: string; name?: string }[] = [];
  if (msg.photo?.length) refs.push({ fileId: msg.photo[msg.photo.length - 1]!.file_id, mimeType: "image/jpeg", name: "photo.jpg" });
  if (msg.document) refs.push({ fileId: msg.document.file_id, mimeType: msg.document.mime_type ?? "application/octet-stream", name: msg.document.file_name });
  if (!refs.length) return null;
  const key = randomBytes(5).toString("hex");
  await redis.set(`file:${key}`, JSON.stringify({ studentId, refs, caption: msg.caption ?? "" }), "EX", 3600);
  return key;
}

export async function unstashFiles(key: string, studentId: string): Promise<{ files: UploadedFile[]; caption: string } | null> {
  const raw = await redis.get(`file:${key}`);
  if (!raw) return null;
  const data = JSON.parse(raw) as { studentId: string; refs: { fileId: string; mimeType: string; name?: string }[]; caption: string };
  if (data.studentId !== studentId) return null;
  const files = await Promise.all(data.refs.map(async (r) => ({ data: await downloadTelegramFile(r.fileId), mimeType: r.mimeType, name: r.name })));
  return { files, caption: data.caption };
}

/** Event id from the buttons of a bot message the user replied to. */
export function eventIdFromReply(ctx: Context): string | null {
  const markup = ctx.message?.reply_to_message?.reply_markup;
  for (const row of markup?.inline_keyboard ?? []) {
    for (const b of row) {
      if ("callback_data" in b && b.callback_data) {
        const m = b.callback_data.match(/^(?:t:\w+|q:ev|ev:\w+):([a-z0-9]{20,})$/);
        if (m) return m[1]!;
      }
    }
  }
  return null;
}

export function argText(ctx: Context): string {
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  return text.replace(/^\/\w+(@\w+)?\s*/, "").trim();
}

export function newCode(len = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
