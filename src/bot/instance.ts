import { Bot } from "grammy";
import { config } from "../config.js";

/**
 * One Telegram bot does everything: reads batch groups it is admin in, posts to
 * the batch channel, and talks to each student in private chat.
 */
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram file has no path (too large?)");
  const res = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
