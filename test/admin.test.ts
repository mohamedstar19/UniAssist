import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { announceQueue, notifyQueue } from "../src/queues.js";
import { createAdminLoginLink } from "../src/web/adminAuth.js";
import { buildWebApp } from "../src/web/server.js";

let app: FastifyInstance;
let cookie = "";

const ORIGIN = "http://localhost:3000"; // PUBLIC_URL default in tests

async function login(tg = "1000"): Promise<string> {
  const link = await createAdminLoginLink(tg);
  const res = await app.inject({ method: "GET", url: link.replace(/^https?:\/\/[^/]+/, "") });
  const set = res.headers["set-cookie"];
  const raw = Array.isArray(set) ? set[0] : set;
  return raw ? raw.split(";")[0]! : "";
}

function post(url: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie, origin: ORIGIN, host: "localhost:3000", "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(form).toString(),
  });
}

beforeAll(async () => {
  app = await buildWebApp();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Reminder","Correction","EventRevision","SolverJob","StudySession","Event","MaterialChunk","Media","RawMessage","Group","LectureSlot","Instructor","Student","Course","Batch","Faculty" CASCADE',
  );
  cookie = await login();
});

afterAll(async () => {
  await app.close();
  await announceQueue.close();
  await notifyQueue.close();
  await redis.quit();
  await db.$disconnect();
});

describe("admin page", () => {
  it("requires login, and login links work once", async () => {
    const anon = await app.inject({ method: "GET", url: "/admin" });
    expect(anon.statusCode).toBe(401);
    expect(anon.body).toContain("/admin");

    const link = await createAdminLoginLink("1000");
    const path = link.replace(/^https?:\/\/[^/]+/, "");
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(303);
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401); // used already

    const ok = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("دفعة جديدة");
  });

  it("refuses non-admins and forged cookies", async () => {
    expect(await login("5555")).toBe(""); // not in ADMIN_TELEGRAM_IDS → no session
    const forged = await app.inject({ method: "GET", url: "/admin", headers: { cookie: "ua_admin=1000%3A99999999999999" } });
    expect(forged.statusCode).toBe(401);
  });

  it("creates a batch, adds and edits courses, renames, changes settings", async () => {
    const created = await post("/admin/batches", { university: "القاهرة", faculty: "هندسة", name: "اتصالات تالتة", year: "2026" });
    expect(created.statusCode).toBe(303);
    const batch = await db.batch.findFirstOrThrow();
    expect(batch.inviteCode).toMatch(/^[A-Z0-9]{6}$/);

    await post(`/admin/b/${batch.id}/courses`, { name: "Networks", code: "CS301", aliases: "نتوركس، شبكات, networks" });
    let course = await db.course.findFirstOrThrow();
    expect(course.aliases).toEqual(["نتوركس", "شبكات", "networks"]);
    await post(`/admin/b/${batch.id}/courses`, { name: "Networks", aliases: "نت" });
    course = await db.course.findFirstOrThrow();
    expect(course.aliases).toEqual(["نت"]);
    expect(course.code).toBe("CS301");

    await post(`/admin/b/${batch.id}/instructors`, { courseId: course.id, name: "د. علي", role: "doctor", phone: "0101-234-5678" });
    expect((await db.instructor.findFirstOrThrow()).phoneHint).toBe("01012345678");
    await post(`/admin/b/${batch.id}/slots`, { courseId: course.id, weekday: "3", time: "10:30" });
    expect(await db.lectureSlot.count()).toBe(1);

    await post(`/admin/b/${batch.id}/rename`, { name: "اتصالات - الفرقة التالتة", year: "2026" });
    expect((await db.batch.findUniqueOrThrow({ where: { id: batch.id } })).name).toBe("اتصالات - الفرقة التالتة");

    await post(`/admin/b/${batch.id}/settings`, { solveDailyLimit: "5", digestHour: "7" }); // checkboxes unchecked
    const features = (await db.batch.findUniqueOrThrow({ where: { id: batch.id } })).features as Record<string, unknown>;
    expect(features).toMatchObject({ solverEnabled: false, repConfirmAll: false, solveDailyLimit: 5, digestHour: 7 });

    const pageRes = await app.inject({ method: "GET", url: `/admin/b/${batch.id}`, headers: { cookie } });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain(batch.inviteCode);
    expect(pageRes.body).toContain("Networks");

    await post(`/admin/b/${batch.id}/courses/${course.id}/delete`, {});
    expect(await db.course.count()).toBe(0);
  });

  it("makes reps, links groups and confirms pending events", async () => {
    await post("/admin/batches", { university: "U", faculty: "F", name: "B" });
    const batch = await db.batch.findFirstOrThrow();
    const s = await db.student.create({ data: { batchId: batch.id, telegramId: "42", name: "Rep", acceptedTermsAt: new Date() } });
    await post(`/admin/b/${batch.id}/students/${s.id}/role`, { role: "rep" });
    expect((await db.student.findUniqueOrThrow({ where: { id: s.id } })).role).toBe("rep");

    const g = await db.group.create({ data: { source: "whatsapp", externalId: "x@g.us", title: "Comm" } });
    await post(`/admin/b/${batch.id}/groups/${g.id}/link`, { type: "batch" });
    expect((await db.group.findUniqueOrThrow({ where: { id: g.id } })).batchId).toBe(batch.id);

    const e = await db.event.create({ data: { batchId: batch.id, type: "quiz", title: "Q", status: "pending", confidence: 0.5, dueAt: new Date(Date.now() + 5 * 86400_000) } });
    await post(`/admin/b/${batch.id}/events/${e.id}/confirm`, {});
    expect((await db.event.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("active");
  });

  it("rejects form posts from other sites", async () => {
    const res = await post("/admin/batches", { university: "U", faculty: "F", name: "B" }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(await db.batch.count()).toBe(0);
  });
});
