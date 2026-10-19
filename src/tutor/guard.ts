import type { Batch, Course, Event } from "@prisma/client";
import { DateTime } from "luxon";
import { parseFeatures, type Features } from "../features.js";
import { db } from "../lib/db.js";
import { startOfDay } from "../lib/time.js";

export interface ExamLock {
  event: Event & { course: Course | null };
  until: Date;
}

/**
 * Lock window of one quiz/exam: from N minutes before it starts until it ends.
 * When only the day is known (stored as 00:00 local), the whole day 08:00–20:00 is locked.
 */
export function lockWindow(e: Pick<Event, "type" | "dueAt" | "durationMinutes">, f: Features, tz: string): { from: Date; until: Date } | null {
  if (!e.dueAt || (e.type !== "quiz" && e.type !== "exam")) return null;
  const local = DateTime.fromJSDate(e.dueAt, { zone: tz });
  if (local.hour === 0 && local.minute === 0) {
    return { from: local.set({ hour: 8 }).minus({ minutes: f.examLockBeforeMinutes }).toJSDate(), until: local.set({ hour: 20 }).toJSDate() };
  }
  const length = e.durationMinutes ?? (e.type === "exam" ? f.defaultExamMinutes : f.defaultQuizMinutes);
  return {
    from: new Date(e.dueAt.getTime() - f.examLockBeforeMinutes * 60_000),
    until: new Date(e.dueAt.getTime() + length * 60_000),
  };
}

/**
 * Study help is switched off for the whole batch while one of its quizzes or
 * exams is running. The assistant is for learning, not for answering a live exam.
 */
export async function activeExamLock(batch: Batch, now = new Date()): Promise<ExamLock | null> {
  const f = parseFeatures(batch.features);
  const maxLen = Math.max(f.defaultExamMinutes, f.defaultQuizMinutes, 21 * 60);
  const candidates = await db.event.findMany({
    where: {
      batchId: batch.id,
      status: "active",
      type: { in: ["quiz", "exam"] },
      dueAt: { gte: new Date(now.getTime() - maxLen * 60_000), lte: new Date(now.getTime() + (f.examLockBeforeMinutes + 9 * 60) * 60_000) },
    },
    include: { course: true },
  });
  let best: ExamLock | null = null;
  for (const e of candidates) {
    const w = lockWindow(e, f, batch.timezone);
    if (w && now >= w.from && now < w.until && (!best || w.until > best.until)) best = { event: e, until: w.until };
  }
  return best;
}

export const HEAVY_MODES = ["solve", "review"] as const;
export const LIGHT_MODES = ["explain", "hint", "quiz", "pastexam", "plan", "ask"] as const;

/** Remaining requests today for the mode's bucket. */
export async function remainingToday(studentId: string, batch: Batch, mode: string): Promise<number> {
  const f = parseFeatures(batch.features);
  const heavy = (HEAVY_MODES as readonly string[]).includes(mode);
  const modes = heavy ? [...HEAVY_MODES] : [...LIGHT_MODES];
  const used = await db.solverJob.count({
    where: { studentId, blocked: null, mode: { in: modes }, createdAt: { gte: startOfDay(batch.timezone) } },
  });
  return (heavy ? f.solveDailyLimit : f.studyDailyLimit) - used;
}
