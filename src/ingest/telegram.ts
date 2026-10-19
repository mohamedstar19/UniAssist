import type { Context } from "grammy";
import { downloadTelegramFile } from "../bot/instance.js";
import type { NormalizedMedia, NormalizedMessage } from "../types.js";

/** Turns a Telegram group message into the common shape. Returns null for anything we ignore. */
export function normalizeTelegram(ctx: Context): NormalizedMessage | null {
  const edited = !ctx.message && !!ctx.editedMessage;
  const msg = ctx.message ?? ctx.editedMessage;
  const chat = ctx.chat;
  if (!msg || !chat || (chat.type !== "group" && chat.type !== "supergroup")) return null;
  // Anonymous group admins post "as the group" (sender_chat = the group itself): keep those.
  const anonymousAdmin = msg.sender_chat?.id === chat.id;
  if (msg.from?.is_bot && !anonymousAdmin) return null;

  const original = msg.text ?? msg.caption ?? "";
  // An edit is ingested as a new message that replies to the original, so it can update the event.
  const text = edited && original ? `(تعديل على رسالة سابقة) ${original}` : original;
  if (original.startsWith("/")) return null; // commands are handled by the bot, not the pipeline

  const media: NormalizedMedia[] = [];
  if (msg.photo?.length && !edited) {
    const largest = msg.photo[msg.photo.length - 1]!;
    media.push({ mimeType: "image/jpeg", sizeBytes: largest.file_size, download: () => downloadTelegramFile(largest.file_id) });
  }
  if (msg.document && !edited) {
    const doc = msg.document;
    media.push({
      mimeType: doc.mime_type ?? "application/octet-stream",
      filename: doc.file_name,
      sizeBytes: doc.file_size,
      download: () => downloadTelegramFile(doc.file_id),
    });
  }
  if (!text && media.length === 0) return null;

  const from = anonymousAdmin ? undefined : msg.from;
  return {
    source: "telegram",
    groupExternalId: String(chat.id),
    groupTitle: chat.title,
    sender: from ? String(from.id) : anonymousAdmin ? `admin:${chat.id}` : "unknown",
    senderName: from ? [from.first_name, from.last_name].filter(Boolean).join(" ") : anonymousAdmin ? `${msg.author_signature ?? "أدمن الجروب"}` : undefined,
    text,
    media,
    sentAt: new Date((edited ? (msg.edit_date ?? msg.date) : msg.date) * 1000),
    replyToExternalId: edited ? String(msg.message_id) : msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    externalId: edited ? `${msg.message_id}:edit:${msg.edit_date ?? Date.now()}` : String(msg.message_id),
  };
}
