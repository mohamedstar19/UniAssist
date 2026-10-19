import { z } from "zod";

/** Per-batch feature flags and limits, stored in Batch.features (JSON). */
export const FeaturesSchema = z.object({
  /** Study assistant (explain / hint / solve / review / quiz) */
  solverEnabled: z.boolean().default(true),
  /** Max solve + review requests per student per day */
  solveDailyLimit: z.number().int().default(3),
  /** Max cheaper study requests (explain, hint, quiz, ask, plan) per student per day */
  studyDailyLimit: z.number().int().default(30),
  /** Rep must confirm every event before it reaches students (recommended for the first 2 weeks) */
  repConfirmAll: z.boolean().default(true),
  /** Events below this confidence wait for the rep */
  confidenceThreshold: z.number().default(0.7),
  /** Study help is locked from this many minutes before a quiz/exam starts... */
  examLockBeforeMinutes: z.number().int().default(30),
  /** ...until it ends. Default lengths when the message doesn't say: */
  defaultQuizMinutes: z.number().int().default(60),
  defaultExamMinutes: z.number().int().default(180),
  /** Daily digest hour (batch timezone) */
  digestHour: z.number().int().min(0).max(23).default(8),
});

export type Features = z.infer<typeof FeaturesSchema>;

export function parseFeatures(raw: unknown): Features {
  const parsed = FeaturesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : FeaturesSchema.parse({});
}

export const ReminderPrefsSchema = z.object({
  /** Minutes before the due time: 3 days, 1 day, 3 hours */
  offsetsMinutes: z.array(z.number().int().positive()).default([3 * 24 * 60, 24 * 60, 180]),
  digest: z.boolean().default(true),
});

export type ReminderPrefs = z.infer<typeof ReminderPrefsSchema>;

export function parseReminderPrefs(raw: unknown): ReminderPrefs {
  const parsed = ReminderPrefsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ReminderPrefsSchema.parse({});
}
