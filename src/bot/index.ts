import { GrammyError } from "grammy";
import { ingestMessage } from "../ingest/store.js";
import { normalizeTelegram } from "../ingest/telegram.js";
import { logger } from "../lib/logger.js";
import { bot } from "./instance.js";
import { registerManageHandlers } from "./manage.js";
import { registerStudentHandlers } from "./student.js";
import { registerStudyHandlers } from "./study.js";

export function setupBot(): void {
  // Order matters: admin/rep commands first (admins may not be registered students),
  // then group ingestion, then the student flows (which require registration).
  registerManageHandlers(bot);

  bot.chatType(["group", "supergroup"]).on(["message", "edited_message"], async (ctx) => {
    const norm = normalizeTelegram(ctx);
    if (norm) await ingestMessage(norm);
  });

  registerStudentHandlers(bot);
  registerStudyHandlers(bot);

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError && e.error_code === 403) return; // user blocked the bot
    logger.error({ err: e, update: err.ctx.update.update_id }, "bot handler error");
    if (err.ctx.chat?.type === "private") {
      err.ctx.reply("حصلت مشكلة 😅 جرب تاني كمان شوية.").catch(() => undefined);
    }
  });
}

export async function setBotCommands(): Promise<void> {
  await bot.api.setMyCommands(
    [
      { command: "today", description: "إيه عليا النهارده" },
      { command: "week", description: "الأسبوع ده" },
      { command: "course", description: "كل حاجة بتخص مادة" },
      { command: "files", description: "ملفات مادة" },
      { command: "explain", description: "اشرحلي سؤال" },
      { command: "hint", description: "تلميح من غير حل" },
      { command: "solve", description: "حل خطوة بخطوة" },
      { command: "review", description: "راجع حلي" },
      { command: "quiz", description: "امتحان تجريبي" },
      { command: "pastexam", description: "امتحانات قديمة" },
      { command: "plan", description: "خطة مذاكرة" },
      { command: "remind", description: "مواعيد التذكير" },
      { command: "mute", description: "سكّت مادة" },
      { command: "link", description: "لينك الأجندة" },
      { command: "help", description: "كل الأوامر" },
    ],
    { scope: { type: "all_private_chats" } },
  );
}
