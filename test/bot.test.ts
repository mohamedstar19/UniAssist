import type { Update } from "grammy/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupBot } from "../src/bot/index.js";
import { bot } from "../src/bot/instance.js";
import { db } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { messagesQueue, notifyQueue } from "../src/queues.js";

/**
 * Drives the real bot handlers with fake Telegram updates. Outgoing API calls
 * are captured instead of being sent.
 */

const ADMIN = 1000; // matches ADMIN_TELEGRAM_IDS in vitest.config.ts
const sent: { method: string; payload: Record<string, unknown> }[] = [];
let updateId = 1;
let messageId = 1;

function texts(): string[] {
  return sent.filter((s) => s.method === "sendMessage").map((s) => String(s.payload.text));
}

async function privateText(fromId: number, text: string, extra: Record<string, unknown> = {}) {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined;
  const update = {
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private", first_name: `U${fromId}` },
      from: { id: fromId, is_bot: false, first_name: `U${fromId}` },
      text,
      ...(entities ? { entities } : {}),
      ...extra,
    },
  } as unknown as Update;
  await bot.handleUpdate(update);
}

async function groupText(chatId: number, fromId: number, text: string) {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Comm 3 group" },
      from: { id: fromId, is_bot: false, first_name: `U${fromId}` },
      text,
      ...(entities ? { entities } : {}),
    },
  } as unknown as Update);
}

async function callback(fromId: number, data: string) {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: `U${fromId}` },
      chat_instance: "x",
      data,
      message: { message_id: 1, date: 0, chat: { id: fromId, type: "private", first_name: "x" }, text: "card" },
    },
  } as unknown as Update);
}

beforeAll(async () => {
  bot.botInfo = {
    id: 42,
    is_bot: true,
    first_name: "UniAssist",
    username: "uniassist_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as typeof bot.botInfo;
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    // Minimal successful responses
    if (method === "sendMessage") return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as never;
    return { ok: true, result: true } as never;
  });
  setupBot();
});

beforeEach(async () => {
  sent.length = 0;
  await db.$executeRawUnsafe(
    'TRUNCATE "Reminder","Correction","EventRevision","SolverJob","StudySession","Event","MaterialChunk","Media","RawMessage","Group","LectureSlot","Instructor","Student","Course","Batch","Faculty" CASCADE',
  );
  await messagesQueue.obliterate({ force: true });
  await notifyQueue.obliterate({ force: true });
});

afterAll(async () => {
  await messagesQueue.close();
  await notifyQueue.close();
  await redis.quit();
  await db.$disconnect();
});

describe("bot flows", () => {
  it("admin sets up a batch, a student joins, accepts terms and asks for the agenda", async () => {
    await privateText(ADMIN, "/newbatch جامعة القاهرة | هندسة | اتصالات - تالتة | 2026");
    const batch = await db.batch.findFirstOrThrow();
    expect(texts().at(-1)).toContain(batch.inviteCode);

    await privateText(ADMIN, "/addcourse Computer Networks | CS301 | نتوركس، networks");
    // Admin is not a student of any batch: must give the invite code first
    expect(await db.course.count()).toBe(0);
    await privateText(ADMIN, `/addcourse ${batch.inviteCode} | Physics | PHY101 | فيزيا`);
    expect((await db.course.findFirstOrThrow()).name).toBe("Physics");

    // Student joins via deep link
    await privateText(2001, `/start join_${batch.inviteCode}`);
    const student = await db.student.findUniqueOrThrow({ where: { telegramId: "2001" } });
    expect(student.acceptedTermsAt).toBeNull();
    expect(texts().some((t) => t.includes("قبل ما نبدأ"))).toBe(true);

    // Before accepting: commands are blocked with the terms
    sent.length = 0;
    await privateText(2001, "/today");
    expect(texts()[0]).toContain("قبل ما نبدأ");

    await callback(2001, "terms:ok");
    expect((await db.student.findUniqueOrThrow({ where: { id: student.id } })).acceptedTermsAt).not.toBeNull();

    sent.length = 0;
    await privateText(2001, "/today");
    expect(texts()[0]).toContain("النهارده");

    sent.length = 0;
    await privateText(2001, "/link");
    expect(texts()[0]).toContain(`/b/${batch.webToken}`);

    // Make them rep, then the rep adds a course
    await privateText(ADMIN, `/makerep ${batch.inviteCode} | 2001`);
    expect((await db.student.findUniqueOrThrow({ where: { id: student.id } })).role).toBe("rep");
    await privateText(2001, "/addcourse Computer Networks | CS301 | نتوركس، networks");
    const course = await db.course.findFirstOrThrow({ where: { name: "Computer Networks" } });
    expect(course.aliases).toEqual(["نتوركس", "networks"]);
  });

  it("rep links a Telegram group; group messages are ingested silently, chatter from unlinked groups is not stored", async () => {
    await privateText(ADMIN, "/newbatch U | F | B | 2026");
    const batch = await db.batch.findFirstOrThrow();

    await groupText(-500, 3001, "الكويز يوم الأحد الساعة 10");
    expect(await db.rawMessage.count()).toBe(0); // group not linked yet
    expect(await db.group.count()).toBe(1); // but recorded for the admin

    await groupText(-500, ADMIN, `/linkgroup ${batch.inviteCode}`);
    expect((await db.group.findFirstOrThrow()).batchId).toBe(batch.id);

    sent.length = 0;
    await groupText(-500, 3001, "الكويز يوم الأحد الساعة 10");
    expect(await db.rawMessage.count()).toBe(1);
    expect(await messagesQueue.count()).toBe(1);
    expect(texts().length).toBe(0); // the bot never talks in the group
  });

  it("anyone can ask for their Telegram id", async () => {
    await privateText(7777, "/myid");
    expect(texts().at(-1)).toContain("7777");
  });

  it("unregistered user with a typed invite code gets registered", async () => {
    await privateText(ADMIN, "/newbatch U | F | B | 2026");
    const batch = await db.batch.findFirstOrThrow();
    await privateText(2002, "hello");
    expect(texts().at(-1)).toContain("كود الدعوة");
    await privateText(2002, batch.inviteCode.toLowerCase());
    expect(await db.student.count({ where: { telegramId: "2002" } })).toBe(1);
  });

  it("students can't act on another batch's events through callback ids", async () => {
    await privateText(ADMIN, "/newbatch U | F | A | 2026");
    await privateText(ADMIN, "/newbatch U | F | B | 2026");
    const [a, b] = await db.batch.findMany({ orderBy: { createdAt: "asc" } });
    await db.student.create({ data: { batchId: a!.id, telegramId: "4001", name: "x", role: "rep", acceptedTermsAt: new Date() } });
    const foreign = await db.event.create({ data: { batchId: b!.id, type: "quiz", title: "B quiz", status: "pending", confidence: 0.5 } });
    await callback(4001, `ev:ok:${foreign.id}`);
    expect((await db.event.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("pending");
  });
});
