import { Queue } from "bullmq";
import { createRedis } from "./lib/redis.js";

/**
 * Each pipeline step runs from a queue so nothing is lost if the LLM or
 * Telegram is down: jobs wait and retry.
 */
export const QUEUE = {
  messages: "messages", // classify + extract one raw message
  notify: "notify", // send one Telegram message
  announce: "announce", // fan out one event announcement to the channel + students
  ticks: "ticks", // repeatable: reminders, digest, cleanup
} as const;

const connection = createRedis();

const defaultJobOptions = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 10_000 },
  // Completed jobs are kept a day so stable job ids keep deduplicating retries.
  removeOnComplete: { age: 24 * 3600, count: 100_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export const messagesQueue = new Queue(QUEUE.messages, { connection, defaultJobOptions });
export const notifyQueue = new Queue(QUEUE.notify, { connection, defaultJobOptions });
export const announceQueue = new Queue(QUEUE.announce, { connection, defaultJobOptions });
export const ticksQueue = new Queue(QUEUE.ticks, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } });

export interface MessageJob {
  rawMessageId: string;
}

export interface AnnounceJob {
  eventId: string;
  kind: "new" | "changed" | "cancelled";
  changeSummary?: string | null;
  /** Stable key of this announcement; per-recipient jobs derive their ids from it so retries never double-send */
  key: string;
}

export interface NotifyJob {
  /** Optional stable job id (dedupes retries) */
  jobKey?: string;
  chatId: string;
  text: string;
  /** Inline keyboard rows: [[{ text, data }]] */
  buttons?: { text: string; data?: string; url?: string }[][];
  reminderId?: string;
}

export async function enqueueMessage(rawMessageId: string): Promise<void> {
  await messagesQueue.add("process", { rawMessageId } satisfies MessageJob, { jobId: `msg-${rawMessageId}` });
}

export async function enqueueNotify(job: NotifyJob): Promise<void> {
  const jobId = job.reminderId ? `rem-${job.reminderId}` : job.jobKey;
  await notifyQueue.add("send", job, jobId ? { jobId } : undefined);
}

export async function enqueueAnnounce(job: AnnounceJob): Promise<void> {
  await announceQueue.add("announce", job, { jobId: job.key });
}
