import Fastify from "fastify";
import { config } from "../config.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getFile } from "../lib/storage.js";
import { formatDue, relativeFromNow } from "../lib/time.js";
import { esc, TYPE_LABEL } from "../notify/format.js";
import { materialLabel } from "../notify/material.js";
import { buildIcs } from "./ics.js";

/**
 * Public batch page: agenda + file library. No login in the MVP: the secret
 * token in the link is the protection (like a Google Docs share link).
 */
export async function startWeb(): Promise<void> {
  const app = Fastify({ logger: false, trustProxy: true });

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { token: string }; Querystring: { c?: string } }>("/b/:token", async (req, reply) => {
    const batch = await db.batch.findUnique({ where: { webToken: req.params.token }, include: { courses: { orderBy: { name: "asc" } } } });
    if (!batch) return reply.code(404).type("text/html").send(page("مش موجود", "<p>اللينك ده مش صحيح.</p>"));
    const courseId = batch.courses.some((c) => c.id === req.query.c) ? req.query.c : undefined;
    const tz = batch.timezone;

    const [events, undated, media] = await Promise.all([
      db.event.findMany({
        where: { batchId: batch.id, status: { in: ["active", "cancelled"] }, dueAt: { gte: new Date(Date.now() - 7 * 86400_000) }, ...(courseId ? { courseId } : {}) },
        include: { course: true },
        orderBy: { dueAt: "asc" },
        take: 200,
      }),
      db.event.findMany({
        where: { batchId: batch.id, status: "active", dueAt: null, ...(courseId ? { courseId } : {}) },
        include: { course: true },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      db.media.findMany({
        where: { batchId: batch.id, ...(courseId ? { courseId } : {}) },
        include: { course: true },
        orderBy: [{ lectureNumber: "asc" }, { createdAt: "asc" }],
        take: 500,
      }),
    ]);

    const now = new Date();
    const card = (e: (typeof events)[number]) => {
      const past = e.dueAt && e.dueAt < now;
      const cls = e.status === "cancelled" ? "card cancelled" : past ? "card past" : "card";
      return `<article class="${cls}">
        <div class="meta"><span class="tag t-${e.type}">${TYPE_LABEL[e.type] ?? e.type}</span>${e.course ? `<span class="course">${esc(e.course.name)}</span>` : ""}${e.status === "cancelled" ? `<span class="tag t-cancel">اتلغى</span>` : ""}</div>
        <h3>${esc(e.title)}</h3>
        ${e.type !== "announcement" || e.dueAt ? `<div class="due">🗓️ ${formatDue(e.dueAt, tz)}${e.dueAt && !past ? ` <small>(${relativeFromNow(e.dueAt)})</small>` : ""}</div>` : ""}
        ${e.description ? `<p>${esc(e.description).replace(/\n/g, "<br>")}</p>` : ""}
      </article>`;
    };

    const upcoming = events.filter((e) => !e.dueAt || e.dueAt >= now);
    const past = events.filter((e) => e.dueAt && e.dueAt < now).reverse();

    const byCourse = new Map<string, typeof media>();
    for (const m of media) {
      const k = m.course?.name ?? "غير مصنف";
      byCourse.set(k, [...(byCourse.get(k) ?? []), m]);
    }
    const library = [...byCourse.entries()]
      .map(
        ([name, items]) => `<details open><summary>${esc(name)} <small>(${items.length})</small></summary><ul class="files">${items
          .map(
            (m) =>
              `<li><a href="/b/${batch.webToken}/f/${m.id}" target="_blank" rel="noopener">${esc(m.title ?? m.filename ?? "ملف")}</a> <small>${materialLabel(m.materialType)}${m.lectureNumber ? ` ${m.lectureNumber}` : ""}</small></li>`,
          )
          .join("")}</ul></details>`,
      )
      .join("");

    const filters = [`<a class="chip ${courseId ? "" : "on"}" href="/b/${batch.webToken}">الكل</a>`]
      .concat(batch.courses.map((c) => `<a class="chip ${c.id === courseId ? "on" : ""}" href="/b/${batch.webToken}?c=${c.id}">${esc(c.name)}</a>`))
      .join("");

    const body = `
      <header><h1>${esc(batch.name)}</h1><a class="ics" href="/b/${batch.webToken}/calendar.ics">📆 أضف للتقويم</a></header>
      <nav class="chips">${filters}</nav>
      <section><h2>الجاي</h2>${upcoming.length ? upcoming.map(card).join("") : `<p class="empty">مفيش حاجة جاية 🎉</p>`}</section>
      ${undated.length ? `<section><h2>ميعادها لسه مش محدد</h2>${undated.map(card).join("")}</section>` : ""}
      <section><h2>مكتبة الملفات</h2>${library || `<p class="empty">لسه مفيش ملفات.</p>`}</section>
      ${past.length ? `<section><details><summary><h2 class="inline">آخر أسبوع</h2></summary>${past.map(card).join("")}</details></section>` : ""}
      <footer>UniAssist · بيتحدث أوتوماتيك من جروبات الدفعة</footer>`;
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex").send(page(batch.name, body));
  });

  app.get<{ Params: { token: string; id: string } }>("/b/:token/f/:id", async (req, reply) => {
    const batch = await db.batch.findUnique({ where: { webToken: req.params.token } });
    const media = batch ? await db.media.findFirst({ where: { id: req.params.id, batchId: batch.id } }) : null;
    if (!media) return reply.code(404).send("not found");
    const data = await getFile(media.storageKey).catch(() => null);
    if (!data) return reply.code(404).send("file is no longer available");
    const name = encodeURIComponent(media.filename ?? `${media.title ?? "file"}`);
    return reply
      .type(media.mimeType)
      .header("content-disposition", `inline; filename*=UTF-8''${name}`)
      .header("x-robots-tag", "noindex")
      .send(data);
  });

  app.get<{ Params: { token: string } }>("/b/:token/calendar.ics", async (req, reply) => {
    const batch = await db.batch.findUnique({ where: { webToken: req.params.token } });
    if (!batch) return reply.code(404).send("not found");
    const events = await db.event.findMany({
      where: { batchId: batch.id, status: "active", dueAt: { not: null, gte: new Date(Date.now() - 60 * 86400_000) } },
      include: { course: true },
    });
    return reply.type("text/calendar; charset=utf-8").send(buildIcs(batch.name, events));
  });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info({ port: config.PORT }, "web server listening");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · UniAssist</title>
<style>
:root{--bg:#f6f7fb;--fg:#1d2433;--muted:#667085;--card:#fff;--line:#e4e7ec;--accent:#3056d3;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e6e9f0;--muted:#98a2b3;--card:#171e2e;--line:#273046;--accent:#7c9cff;--chip:#1f2940}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:1.4rem;margin:8px 0}
h2{font-size:1.1rem;margin:24px 0 8px}h2.inline{display:inline;margin:0}h3{margin:4px 0;font-size:1rem}
a{color:var(--accent)}.ics{font-size:.9rem;text-decoration:none}
.chips{display:flex;gap:8px;overflow-x:auto;padding:4px 0}.chip{white-space:nowrap;padding:4px 12px;border-radius:999px;background:var(--chip);text-decoration:none;color:var(--fg);font-size:.9rem}.chip.on{background:var(--accent);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.card.past{opacity:.6}.card.cancelled h3{text-decoration:line-through}.card p{margin:6px 0 0;color:var(--muted);font-size:.95rem}
.meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.85rem}.course{font-weight:600}
.tag{padding:1px 8px;border-radius:6px;background:var(--chip)}.t-exam{background:#fde2e2;color:#9b1c1c}.t-quiz{background:#fff1d6;color:#8a5a00}.t-assignment{background:#dcf5e7;color:#0f5c36}.t-cancel{background:#eee;color:#555}
@media (prefers-color-scheme:dark){.t-exam{background:#4a1d1d;color:#ffb4b4}.t-quiz{background:#45360f;color:#ffd98a}.t-assignment{background:#143d2a;color:#a6f0c6}.t-cancel{background:#333;color:#bbb}}
.due{font-size:.95rem}details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 14px;margin:8px 0}summary{cursor:pointer;font-weight:600}
.files{margin:8px 0;padding-inline-start:18px}.files li{margin:4px 0}.files small,.due small{color:var(--muted)}
.empty{color:var(--muted)}footer{margin:32px 0 8px;color:var(--muted);font-size:.8rem;text-align:center}
</style></head><body><main>${body}</main></body></html>`;
}
