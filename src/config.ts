import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.string().default("production"),
  LOG_LEVEL: z.string().default("info"),
  /** Which parts of the app this process runs: all | ingest | workers | bot | web (comma separated) */
  ROLES: z.string().default("all"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_FAST: z.string().default("claude-haiku-5-5"),
  MODEL_SMART: z.string().default("claude-sonnet-5-5"),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Telegram user ids of the admins (comma separated) */
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),

  WHATSAPP_ENABLED: bool,
  WHATSAPP_AUTH_DIR: z.string().default("./data/whatsapp-auth"),

  /** Public base URL of the web page, e.g. https://uni.example.com */
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3000),

  /** File storage. If S3_BUCKET is empty files are kept on local disk. */
  STORAGE_DIR: z.string().default("./data/files"),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  /** Days to keep the text of messages classified as noise */
  NOISE_RETENTION_DAYS: z.coerce.number().default(30),
});

export type Config = z.infer<typeof EnvSchema>;

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();

export function hasRole(role: string): boolean {
  const roles = config.ROLES.split(",").map((r) => r.trim());
  return roles.includes("all") || roles.includes(role);
}
