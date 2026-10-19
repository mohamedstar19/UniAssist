import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://ua:ua@localhost:5432/uniassist_test",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      TELEGRAM_BOT_TOKEN: "123:test",
      ANTHROPIC_API_KEY: "test",
      LOG_LEVEL: "silent",
    },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
