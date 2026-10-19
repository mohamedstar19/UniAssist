import { run } from "@grammyjs/runner";
import * as Sentry from "@sentry/node";
import { alertAdmins } from "./admin/alerts.js";
import { setBotCommands, setupBot } from "./bot/index.js";
import { bot } from "./bot/instance.js";
import { config, hasRole } from "./config.js";
import { startWhatsApp } from "./ingest/whatsapp.js";
import { db } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { startWeb } from "./web/server.js";
import { startWorkers } from "./workers.js";

const running: { close: () => Promise<void> }[] = [];

async function main(): Promise<void> {
  if (config.SENTRY_DSN) Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV });
  if (!config.ANTHROPIC_API_KEY) logger.warn("ANTHROPIC_API_KEY is not set: classification and the study assistant will fail");

  await db.$connect();
  // Fetches the bot username (used in links). The web role alone doesn't need Telegram.
  if (hasRole("bot") || hasRole("workers") || hasRole("ingest")) await bot.init();

  if (hasRole("workers")) running.push(...(await startWorkers()));
  if (hasRole("web")) await startWeb();
  if (hasRole("ingest") && config.WHATSAPP_ENABLED) await startWhatsApp();
  if (hasRole("bot")) {
    setupBot();
    await setBotCommands().catch((err) => logger.warn({ err }, "setMyCommands failed"));
    // Long polling (no public webhook needed), handling many chats in parallel.
    // Updates of the same chat stay in order (see sequentialize in setupBot).
    const runner = run(bot, {
      runner: { fetch: { allowed_updates: ["message", "edited_message", "channel_post", "callback_query", "my_chat_member"] } },
    });
    running.push({ close: () => (runner.isRunning() ? runner.stop() : Promise.resolve()) });
    logger.info({ bot: bot.botInfo.username }, "telegram bot started");
  }

  logger.info({ roles: config.ROLES }, "UniAssist is running");
}

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandled rejection");
  Sentry.captureException(err);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, "shutting down");
    await Promise.allSettled(running.map((w) => w.close()));
    await db.$disconnect();
    process.exit(0);
  });
}

main().catch(async (err) => {
  logger.fatal({ err }, "startup failed");
  Sentry.captureException(err);
  await alertAdmins(`🚨 UniAssist مقدرش يشتغل: ${String(err).slice(0, 300)}`).catch(() => undefined);
  process.exit(1);
});
