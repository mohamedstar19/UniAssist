import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { redis } from "../lib/redis.js";

/**
 * Admin login without passwords: the admin sends /admin to the bot and gets a
 * one-time link (valid 10 minutes). Opening it sets a signed session cookie.
 */

export const SESSION_COOKIE = "ua_admin";
const SESSION_DAYS = 7;
const LOGIN_TTL_SECONDS = 10 * 60;

export function cookieSecret(): string {
  return config.SESSION_SECRET ?? createHash("sha256").update(`uniassist-session:${config.TELEGRAM_BOT_TOKEN}`).digest("hex");
}

/** Creates a one-time login link for an admin (called by the bot's /admin command). */
export async function createAdminLoginLink(telegramId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await redis.set(`adminlogin:${token}`, telegramId, "EX", LOGIN_TTL_SECONDS);
  return `${config.PUBLIC_URL}/admin/login?t=${token}`;
}

export async function consumeLoginToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  return redis.getdel(`adminlogin:${token}`);
}

export function startSession(reply: FastifyReply, telegramId: string): void {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  reply.setCookie(SESSION_COOKIE, `${telegramId}:${exp}`, {
    signed: true,
    httpOnly: true,
    sameSite: "strict",
    secure: config.PUBLIC_URL.startsWith("https://"),
    path: "/admin",
    maxAge: SESSION_DAYS * 86400,
  });
}

export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/admin" });
}

/** The logged-in admin's Telegram id, or null. Admin rights are re-checked against the current config. */
export function sessionAdmin(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const [tg, exp] = unsigned.value.split(":");
  if (!tg || !exp || Number(exp) < Date.now()) return null;
  return config.ADMIN_TELEGRAM_IDS.includes(tg) ? tg : null;
}

/** Forms are only accepted from our own pages (on top of the SameSite=Strict cookie). */
export function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return true; // some browsers omit both on same-origin POSTs; the strict cookie still protects
  try {
    const o = new URL(origin);
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    return o.host === host || o.origin === new URL(config.PUBLIC_URL).origin;
  } catch {
    return false;
  }
}
