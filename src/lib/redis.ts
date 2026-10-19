import { Redis } from "ioredis";
import { config } from "../config.js";

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

/** Shared connection for small key/value state (bot pending actions, etc.). */
export const redis = createRedis();
