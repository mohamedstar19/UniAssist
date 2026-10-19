import { UnrecoverableError, Worker } from "bullmq";
import { GrammyError, InlineKeyboard } from "grammy";
import { alertAdmins } from "./admin/alerts.js";
import { bot } from "./bot/instance.js";
import { config } from "./config.js";
import { db } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";
import { sendDigests } from "./notify/digest.js";
import { fireDueReminders } from "./notify/reminders.js";
import { processRawMessage } from "./pipeline/process.js";
import { type MessageJob, type NotifyJob, QUEUE, ticksQueue } from "./queues.js";

export async function startWorkers(): Promise<Worker[]> {
  // Messages are processed one at a time so a date change is always applied after the original announcement.
  const messages = new Worker<MessageJob>(QUEUE.messages, async (job) => processRawMessage(job.data.rawMessageId), {
    connection: createRedis(),
    concurrency: 1,
  });
  messages.on("failed", async (job, err) => {
    logger.error({ err, jobId: job?.id }, "message job failed");
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await alertAdmins(`⚠️ رسالة فشلت في التحليل بعد كل المحاولات (${job.data.rawMessageId}): ${err.message.slice(0, 300)}`);
    }
  });

  // Telegram allows ~30 messages/second; stay under it.
  const notify = new Worker<NotifyJob>(
    QUEUE.notify,
    async (job) => {
      const { chatId, text, buttons } = job.data;
      const kb = buttons?.length ? new InlineKeyboard(buttons.map((row) => row.map((b) => (b.url ? InlineKeyboard.url(b.text, b.url) : InlineKeyboard.text(b.text, b.data ?? "noop"))))) : undefined;
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 403 || err.error_code === 400 && /chat not found/i.test(err.description)) {
            throw new UnrecoverableError(`cannot message ${chatId}: ${err.description}`);
          }
          if (err.error_code === 400 && /parse entities/i.test(err.description)) {
            await bot.api.sendMessage(chatId, text.replace(/<[^>]+>/g, ""), { reply_markup: kb });
            return;
          }
        }
        throw err;
      }
    },
    { connection: createRedis(), concurrency: 5, limiter: { max: 25, duration: 1000 } },
  );
  notify.on("failed", (job, err) => logger.warn({ err: err.message, chatId: job?.data.chatId }, "notify failed"));

  const ticks = new Worker(
    QUEUE.ticks,
    async (job) => {
      if (job.name === "reminders") await fireDueReminders();
      if (job.name === "digest") await sendDigests();
      if (job.name === "cleanup") await cleanup();
    },
    { connection: createRedis(), concurrency: 1 },
  );
  ticks.on("failed", (job, err) => logger.error({ err, job: job?.name }, "tick failed"));

  await ticksQueue.upsertJobScheduler("reminders", { every: 60_000 }, { name: "reminders" });
  await ticksQueue.upsertJobScheduler("digest", { pattern: "1 * * * *" }, { name: "digest" });
  await ticksQueue.upsertJobScheduler("cleanup", { pattern: "30 3 * * *", tz: "Africa/Cairo" }, { name: "cleanup" });

  logger.info("workers started");
  return [messages, notify, ticks];
}

/** Privacy: chatter is kept only N days; finished study sessions only a week. */
async function cleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - config.NOISE_RETENTION_DAYS * 86400_000);
  const wiped = await db.rawMessage.updateMany({
    where: { classification: "noise", createdAt: { lt: cutoff }, text: { not: null } },
    data: { text: null, senderName: null },
  });
  await db.studySession.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
  logger.info({ wiped: wiped.count }, "cleanup done");
}
