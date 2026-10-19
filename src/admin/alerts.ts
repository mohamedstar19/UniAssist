import { InputFile } from "grammy";
import { bot } from "../bot/instance.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/** Direct (not queued) alerts to the admins: these are the ones that must arrive. */
export async function alertAdmins(text: string): Promise<void> {
  for (const id of config.ADMIN_TELEGRAM_IDS) {
    try {
      await bot.api.sendMessage(id, text);
    } catch (err) {
      logger.error({ err, id }, "admin alert failed");
    }
  }
}

export async function alertAdminsPhoto(png: Buffer, caption: string): Promise<void> {
  for (const id of config.ADMIN_TELEGRAM_IDS) {
    try {
      await bot.api.sendPhoto(id, new InputFile(png, "qr.png"), { caption });
    } catch (err) {
      logger.error({ err, id }, "admin photo alert failed");
    }
  }
}
