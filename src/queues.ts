import { Queue } from "bullmq";
import { createRedis } from "./lib/redis.js";

/**
 * Each pipeline step runs from a queue so nothing is lost if the LLM or
 * Telegram is down: jobs wait and retry.
 */
export const QUEUE = {
  messages: "messages", // classify + extract one raw message
  notify: "notify", // send one Telegram message
  ticks: "ticks", // repeatable: reminders, digest, cleanup
} as const;

const connection = createRedis();

const defaultJobOptions = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const messagesQueue = new Queue(QUEUE.messages, { connection, defaultJobOptions });
export const notifyQueue = new Queue(QUEUE.notify, { connection, defaultJobOptions });
export const ticksQueue = new Queue(QUEUE.ticks, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } });

export interface MessageJob {
  rawMessageId: string;
}

export interface NotifyJob {
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
  await notifyQueue.add("send", job, job.reminderId ? { jobId: `rem-${job.reminderId}` } : undefined);
}
