import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import type { Batch, GroupType, InstructorRole } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createBatch, splitAliases } from "../admin/batches.js";
import { bot } from "../bot/instance.js";
import { config } from "../config.js";
import { FeaturesSchema, parseFeatures } from "../features.js";
import { db } from "../lib/db.js";
import { formatDue } from "../lib/time.js";
import { esc, TYPE_LABEL } from "../notify/format.js";
import { scheduleEventReminders } from "../notify/reminders.js";
import { applyPatch, confirmEvent } from "../pipeline/events.js";
import { consumeLoginToken, cookieSecret, endSession, sameOrigin, sessionAdmin, startSession } from "./adminAuth.js";
import { page } from "./layout.js";

/**
 * Admin web page (Arabic): batches, courses, instructors, lecture schedule,
 * students and reps, groups, pending events and settings. Login is a one-time
 * link the bot sends to admins (/admin).
 */

type Form = Record<string, string | undefined>;
const WEEKDAYS = ["", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت", "الحد"];

function botUsername(): string | null {
  try {
    return bot.botInfo.username;
  } catch {
    return null;
  }
}

function backTo(reply: FastifyReply, path: string, message: string, error = false): FastifyReply {
  const sep = path.includes("?") ? "&" : "?";
  return reply.redirect(`${path}${sep}${error ? "e" : "m"}=${encodeURIComponent(message)}`, 303);
}

function flash(req: FastifyRequest): string {
  const q = req.query as { m?: string; e?: string };
  if (q.e) return `<div class="flash err">⚠️ ${esc(q.e)}</div>`;
  if (q.m) return `<div class="flash ok">✅ ${esc(q.m)}</div>`;
  return "";
}

function adminPage(title: string, body: string, opts: { nav?: boolean } = {}): string {
  const nav = opts.nav === false ? "" : `<nav class="top"><a href="/admin">🏠 الدفعات</a><form method="post" action="/admin/logout"><button class="link">خروج</button></form></nav>`;
  return page(`${title} · الأدمن`, `${ADMIN_CSS}${nav}${body}`);
}

const ADMIN_CSS = `<style>
nav.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
nav.top a{text-decoration:none;font-weight:600}
.flash{padding:10px 14px;border-radius:10px;margin:10px 0}.flash.ok{background:#dcf5e7;color:#0f5c36}.flash.err{background:#fde2e2;color:#9b1c1c}
@media (prefers-color-scheme:dark){.flash.ok{background:#143d2a;color:#a6f0c6}.flash.err{background:#4a1d1d;color:#ffb4b4}}
form.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0;display:grid;gap:8px}
form.inline{display:inline}
label{display:grid;gap:4px;font-size:.9rem;color:var(--muted)}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
input[type=checkbox]{width:auto}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.danger{background:#c0392b}button.link{background:none;color:var(--accent);padding:0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:.92rem}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:start;vertical-align:top}
.tablewrap{overflow-x:auto}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kv b{color:var(--muted);font-weight:500}
code.big{font-size:1.2rem;letter-spacing:2px}
.hint{color:var(--muted);font-size:.85rem;margin:4px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}.stat b{display:block;font-size:1.4rem}
</style>`;

const confirmJs = (msg: string) => `onsubmit="return confirm('${msg}')"`;

export async function registerAdmin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie, { secret: cookieSecret() });
  await app.register(fastifyFormbody);

  // ---- auth ----------------------------------------------------------------------------------
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    if (req.url.startsWith("/admin/login")) return;
    const admin = sessionAdmin(req);
    if (!admin) {
      if (req.method === "GET") return reply.code(401).type("text/html; charset=utf-8").send(loginHelp());
      return reply.code(401).send("unauthorized");
    }
    if (req.method === "POST" && !sameOrigin(req)) return reply.code(403).send("forbidden");
  });

  app.get<{ Querystring: { t?: string } }>("/admin/login", async (req, reply) => {
    const tg = req.query.t ? await consumeLoginToken(req.query.t) : null;
    if (!tg || !config.ADMIN_TELEGRAM_IDS.includes(tg)) {
      return reply.code(401).type("text/html; charset=utf-8").send(loginHelp("اللينك ده انتهى أو اتستخدم قبل كده."));
    }
    startSession(reply, tg);
    return reply.redirect("/admin", 303);
  });

  app.post("/admin/logout", async (_req, reply) => {
    endSession(reply);
    return reply.type("text/html; charset=utf-8").send(loginHelp("خرجت. علشان تدخل تاني ابعت /admin للبوت."));
  });

  // ---- dashboard -------------------------------------------------------------------------------
  app.get("/admin", async (req, reply) => {
    const batches = await db.batch.findMany({
      include: { faculty: true, _count: { select: { students: true, courses: true, groups: true } } },
      orderBy: { createdAt: "desc" },
    });
    const pending = await db.event.groupBy({ by: ["batchId"], where: { status: "pending" }, _count: true });
    const pendingBy = new Map(pending.map((p) => [p.batchId, p._count]));
    const unlinked = await db.group.count({ where: { batchId: null } });

    const rows = batches
      .map(
        (b) => `<tr><td><a href="/admin/b/${b.id}"><b>${esc(b.name)}</b></a><div class="hint">${esc(b.faculty.university)} · ${esc(b.faculty.name)} · ${b.year}</div></td>
        <td>${b._count.courses}</td><td>${b._count.students}</td><td>${b._count.groups}</td><td>${pendingBy.get(b.id) ? `<b>${pendingBy.get(b.id)}</b>` : "0"}</td></tr>`,
      )
      .join("");

    const body = `<h1>لوحة الأدمن</h1>${flash(req)}
      ${unlinked ? `<div class="flash err">فيه ${unlinked} جروب البوت شايفه ومش مربوط بدفعة. افتح الدفعة واربطه من قسم الجروبات.</div>` : ""}
      <h2>الدفعات</h2>
      ${batches.length ? `<div class="tablewrap"><table><tr><th>الدفعة</th><th>المواد</th><th>الطلبة</th><th>الجروبات</th><th>مستني تأكيد</th></tr>${rows}</table></div>` : `<p class="empty">لسه مفيش دفعات. اعمل أول دفعة من تحت 👇</p>`}
      <h2>دفعة جديدة</h2>
      <form class="box" method="post" action="/admin/batches">
        <div class="row">
          <label>الجامعة<input name="university" required placeholder="جامعة القاهرة"></label>
          <label>الكلية<input name="faculty" required placeholder="كلية الهندسة"></label>
        </div>
        <div class="row">
          <label>اسم الدفعة<input name="name" required placeholder="اتصالات - الفرقة التالتة"></label>
          <label>السنة<input name="year" type="number" value="${new Date().getFullYear()}"></label>
        </div>
        <button>إنشاء الدفعة</button>
      </form>`;
    return reply.type("text/html; charset=utf-8").send(adminPage("الدفعات", body));
  });

  app.post<{ Body: Form }>("/admin/batches", async (req, reply) => {
    const { university, faculty, name, year } = req.body;
    if (!university?.trim() || !faculty?.trim() || !name?.trim()) return backTo(reply, "/admin", "املا الجامعة والكلية واسم الدفعة", true);
    const batch = await createBatch({ university: university.trim(), facultyName: faculty.trim(), name: name.trim(), year: Number(year) });
    return backTo(reply, `/admin/b/${batch.id}`, "الدفعة اتعملت. ضيف المواد وابعت لينك التسجيل للطلبة.");
  });

  // ---- batch page ------------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/admin/b/:id", async (req, reply) => {
    const batch = await db.batch.findUnique({
      where: { id: req.params.id },
      include: {
        faculty: true,
        courses: { orderBy: { name: "asc" }, include: { instructors: true, lectureSlots: true } },
        students: { orderBy: [{ role: "desc" }, { joinedAt: "asc" }] },
        groups: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!batch) return reply.code(404).send("not found");
    const pending = await db.event.findMany({ where: { batchId: batch.id, status: "pending" }, include: { course: true, createdFromMessage: true }, orderBy: { createdAt: "asc" } });
    const unlinked = await db.group.findMany({ where: { batchId: null }, orderBy: { createdAt: "desc" }, take: 30 });
    const upcoming = await db.event.findMany({
      where: { batchId: batch.id, status: "active", dueAt: { gte: new Date() } },
      include: { course: true },
      orderBy: { dueAt: "asc" },
      take: 15,
    });
    const f = parseFeatures(batch.features);
    const me = botUsername();
    const signup = me ? `https://t.me/${me}?start=join_${batch.inviteCode}` : null;
    const agenda = `${config.PUBLIC_URL}/b/${batch.webToken}`;
    const base = `/admin/b/${batch.id}`;
    const courseOptions = batch.courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

    const info = `<div class="kv">
      <b>كود الدعوة</b><code class="big">${batch.inviteCode}</code>
      <b>لينك التسجيل</b><span>${signup ? `<a href="${esc(signup)}" target="_blank">${esc(signup)}</a>` : "-"}<div class="hint">ابعته لطلبة الدفعة: بيفتح البوت ويسجلهم على طول.</div></span>
      <b>أجندة الدفعة</b><a href="${esc(agenda)}" target="_blank">${esc(agenda)}</a>
      <b>القناة</b><span>${batch.channelId ? "مربوطة ✅" : `مش مربوطة <div class="hint">اعمل قناة تيليجرام، ضيف البوت أدمن فيها، واكتب فيها: <code>/linkchannel ${batch.inviteCode}</code></div>`}</span>
    </div>`;

    const stats = `<div class="stats">
      <div class="stat"><b>${batch.courses.length}</b>مواد</div>
      <div class="stat"><b>${batch.students.length}</b>طلبة</div>
      <div class="stat"><b>${batch.groups.length}</b>جروبات</div>
      <div class="stat"><b>${pending.length}</b>مستني تأكيد</div>
    </div>`;

    const pendingHtml = pending.length
      ? pending
          .map(
            (e) => `<div class="card"><div class="meta"><span class="tag t-${e.type}">${TYPE_LABEL[e.type] ?? e.type}</span>${e.course ? `<span class="course">${esc(e.course.name)}</span>` : ""}</div>
            <h3>${esc(e.title)}</h3><div class="due">🗓️ ${formatDue(e.dueAt, batch.timezone)}</div>
            ${e.description ? `<p>${esc(e.description)}</p>` : ""}
            ${e.createdFromMessage?.text ? `<p class="hint">💬 ${esc(e.createdFromMessage.text.slice(0, 300))}</p>` : ""}
            <form class="inline" method="post" action="${base}/events/${e.id}/confirm"><button>✅ تأكيد وإرسال للدفعة</button></form>
            <form class="inline" method="post" action="${base}/events/${e.id}/reject"><button class="ghost">❌ مش حدث</button></form></div>`,
          )
          .join("")
      : `<p class="empty">مفيش حاجة مستنية 👌</p>`;

    const coursesHtml = batch.courses.length
      ? `<div class="tablewrap"><table><tr><th>المادة</th><th>الكود</th><th>أسماء تانية</th><th>الدكاترة</th><th>المحاضرات</th><th></th></tr>${batch.courses
          .map(
            (c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.code ?? "")}</td><td>${esc(c.aliases.join("، "))}</td>
            <td>${c.instructors.map((i) => `${esc(i.name)} <span class="hint">(${i.role === "ta" ? "معيد" : "دكتور"}${i.phoneHint ? ` · ${esc(i.phoneHint)}` : ""})</span> <form class="inline" method="post" action="${base}/instructors/${i.id}/delete"><button class="link">✕</button></form>`).join("<br>") || "-"}</td>
            <td>${c.lectureSlots.map((l) => `${WEEKDAYS[l.weekday]} ${esc(l.startTime)} <form class="inline" method="post" action="${base}/slots/${l.id}/delete"><button class="link">✕</button></form>`).join("<br>") || "-"}</td>
            <td><form class="inline" method="post" action="${base}/courses/${c.id}/delete" ${confirmJs("تمسح المادة دي؟ الأحداث والملفات بتاعتها هتفضل بس من غير مادة.")}><button class="link">مسح</button></form></td></tr>`,
          )
          .join("")}</table></div>`
      : `<p class="empty">لسه مفيش مواد.</p>`;

    const studentsHtml = batch.students.length
      ? `<div class="tablewrap"><table><tr><th>الاسم</th><th>Telegram ID</th><th>الدور</th><th>وافق على الشروط</th><th></th></tr>${batch.students
          .map(
            (s) => `<tr><td>${esc(s.name)}</td><td><code>${esc(s.telegramId)}</code></td><td>${s.role === "rep" ? "⭐ مندوب" : "طالب"}</td><td>${s.acceptedTermsAt ? "✅" : "لسه"}</td>
            <td><form class="inline" method="post" action="${base}/students/${s.id}/role"><input type="hidden" name="role" value="${s.role === "rep" ? "student" : "rep"}"><button class="ghost">${s.role === "rep" ? "شيل المندوب" : "اعمله مندوب"}</button></form></td></tr>`,
          )
          .join("")}</table></div>`
      : `<p class="empty">لسه محدش سجل. ابعت لينك التسجيل للطلبة.</p>`;

    const groupsHtml = `${
      batch.groups.length
        ? `<div class="tablewrap"><table><tr><th>الجروب</th><th>المصدر</th><th>النوع</th><th></th></tr>${batch.groups
            .map(
              (g) => `<tr><td>${esc(g.title ?? g.externalId)}</td><td>${g.source === "whatsapp" ? "واتساب" : "تيليجرام"}</td><td>${g.type}</td>
              <td><form class="inline" method="post" action="${base}/groups/${g.id}/unlink" ${confirmJs("تفك ربط الجروب ده؟ رسايله مش هتتقري تاني.")}><button class="link">فك الربط</button></form></td></tr>`,
            )
            .join("")}</table></div>`
        : `<p class="empty">مفيش جروبات مربوطة.</p>`
    }
      ${
        unlinked.length
          ? `<h3>جروبات البوت شايفها ومش مربوطة</h3><div class="tablewrap"><table><tr><th>الجروب</th><th>المصدر</th><th></th></tr>${unlinked
              .map(
                (g) => `<tr><td>${esc(g.title ?? g.externalId)}</td><td>${g.source === "whatsapp" ? "واتساب" : "تيليجرام"}</td>
                <td><form class="inline" method="post" action="${base}/groups/${g.id}/link"><select name="type"><option value="batch">جروب الدفعة</option><option value="section">سكشن</option><option value="course">مادة</option></select> <button>اربطه بالدفعة دي</button></form></td></tr>`,
              )
              .join("")}</table></div>`
          : ""
      }
      <p class="hint">جروب تيليجرام: ضيف البوت @${esc(me ?? "")} أدمن في الجروب واكتب فيه <code>/linkgroup ${batch.inviteCode}</code>. جروب واتساب: ضيف رقم الواتساب المخصص للجروب وهيظهر هنا تحت "مش مربوطة".</p>`;

    const upcomingHtml = upcoming.length
      ? `<div class="tablewrap"><table><tr><th>الحدث</th><th>المادة</th><th>الميعاد</th><th></th></tr>${upcoming
          .map(
            (e) => `<tr><td>${TYPE_LABEL[e.type] ?? e.type}: ${esc(e.title)}</td><td>${esc(e.course?.name ?? "-")}</td><td>${formatDue(e.dueAt, batch.timezone)}</td>
            <td><form class="inline" method="post" action="${base}/events/${e.id}/cancel" ${confirmJs("تلغي الحدث ده؟ الطلبة هيوصلهم إنه اتلغى.")}><button class="link">إلغاء</button></form></td></tr>`,
          )
          .join("")}</table></div>`
      : `<p class="empty">مفيش مواعيد جاية.</p>`;

    const settingsHtml = `<form class="box" method="post" action="${base}/rename">
      <div class="row">
        <label>اسم الدفعة<input name="name" required value="${esc(batch.name)}"></label>
        <label>السنة<input name="year" type="number" value="${batch.year}"></label>
      </div>
      <button>حفظ الاسم</button>
    </form>
    <form class="box" method="post" action="${base}/settings">
      <label><span><input type="checkbox" name="solverEnabled" ${f.solverEnabled ? "checked" : ""}> مساعد المذاكرة شغال</span></label>
      <label><span><input type="checkbox" name="repConfirmAll" ${f.repConfirmAll ? "checked" : ""}> كل حدث يعدي على المندوب الأول قبل ما يتبعت للطلبة (مستحسن أول أسبوعين)</span></label>
      <div class="row">
        <label>طلبات الحل والمراجعة لكل طالب في اليوم<input type="number" name="solveDailyLimit" min="0" value="${f.solveDailyLimit}"></label>
        <label>طلبات المذاكرة التانية في اليوم<input type="number" name="studyDailyLimit" min="0" value="${f.studyDailyLimit}"></label>
        <label>ساعة الملخص اليومي (0-23)<input type="number" name="digestHour" min="0" max="23" value="${f.digestHour}"></label>
        <label>إيقاف المساعد قبل الامتحان بـ (دقيقة)<input type="number" name="examLockBeforeMinutes" min="0" value="${f.examLockBeforeMinutes}"></label>
      </div>
      <button>حفظ الإعدادات</button>
    </form>`;

    const body = `<h1>${esc(batch.name)}</h1><div class="hint">${esc(batch.faculty.university)} · ${esc(batch.faculty.name)} · ${batch.year}</div>
      ${flash(req)}${stats}
      <h2>بيانات الدفعة</h2>${info}
      <h2>مستني تأكيدك (${pending.length})</h2>${pendingHtml}
      <h2>المواد</h2>${coursesHtml}
      <form class="box" method="post" action="${base}/courses">
        <b>إضافة مادة</b>
        <div class="row">
          <label>اسم المادة<input name="name" required placeholder="Computer Networks"></label>
          <label>كود المادة (اختياري)<input name="code" placeholder="CS301"></label>
        </div>
        <label>أسماء تانية بيكتبها الطلبة (افصل بفاصلة)<input name="aliases" placeholder="نتوركس، شبكات، networks"></label>
        <p class="hint">كل ما تضيف أسماء أكتر، النظام بيعرف المادة من رسايل الجروب أحسن. لو المادة موجودة، الأسماء دي بتتحدث.</p>
        <button>إضافة المادة</button>
      </form>
      ${
        batch.courses.length
          ? `<form class="box" method="post" action="${base}/instructors">
        <b>إضافة دكتور أو معيد</b>
        <div class="row">
          <label>المادة<select name="courseId">${courseOptions}</select></label>
          <label>الاسم<input name="name" required placeholder="د. أحمد علي"></label>
          <label>الصفة<select name="role"><option value="doctor">دكتور</option><option value="ta">معيد</option></select></label>
          <label>رقم الموبايل (اختياري)<input name="phone" placeholder="01012345678"></label>
        </div>
        <p class="hint">برقم الموبايل النظام بيعرف إن الرسالة من الدكتور، وكلامه بيكسب لو حصل تعارض مع كلام طالب.</p>
        <button>إضافة</button>
      </form>
      <form class="box" method="post" action="${base}/slots">
        <b>جدول المحاضرات</b>
        <div class="row">
          <label>المادة<select name="courseId">${courseOptions}</select></label>
          <label>اليوم<select name="weekday">${[6, 7, 1, 2, 3, 4, 5].map((d) => `<option value="${d}">${WEEKDAYS[d]}</option>`).join("")}</select></label>
          <label>الساعة<input type="time" name="time" required value="10:00"></label>
        </div>
        <p class="hint">بيخلي النظام يفهم جمل زي "الكويز المحاضرة الجاية".</p>
        <button>إضافة محاضرة</button>
      </form>`
          : ""
      }
      <h2>المواعيد الجاية</h2>${upcomingHtml}
      <h2>الطلبة والمندوبين</h2>${studentsHtml}
      <h2>الجروبات</h2>${groupsHtml}
      <h2>الإعدادات</h2>${settingsHtml}`;
    return reply.type("text/html; charset=utf-8").send(adminPage(batch.name, body));
  });

  // ---- batch actions ---------------------------------------------------------------------------
  const withBatch = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<Batch | null> => {
    const batch = await db.batch.findUnique({ where: { id: req.params.id } });
    if (!batch) {
      await reply.code(404).send("not found");
      return null;
    }
    return batch;
  };

  app.post<{ Params: { id: string }; Body: Form }>("/admin/b/:id/courses", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const name = req.body.name?.trim();
    if (!name) return backTo(reply, `/admin/b/${batch.id}`, "اكتب اسم المادة", true);
    const aliases = splitAliases(req.body.aliases);
    const code = req.body.code?.trim() || null;
    await db.course.upsert({
      where: { batchId_name: { batchId: batch.id, name } },
      create: { batchId: batch.id, name, code, aliases },
      update: { code: code ?? undefined, aliases },
    });
    return backTo(reply, `/admin/b/${batch.id}`, `المادة "${name}" اتحفظت`);
  });

  app.post<{ Params: { id: string; courseId: string } }>("/admin/b/:id/courses/:courseId/delete", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const course = await db.course.findFirst({ where: { id: req.params.courseId, batchId: batch.id } });
    if (course) {
      await db.$transaction([
        db.event.updateMany({ where: { courseId: course.id }, data: { courseId: null } }),
        db.media.updateMany({ where: { courseId: course.id }, data: { courseId: null } }),
        db.materialChunk.updateMany({ where: { courseId: course.id }, data: { courseId: null } }),
        db.course.delete({ where: { id: course.id } }),
      ]);
    }
    return backTo(reply, `/admin/b/${batch.id}`, "المادة اتمسحت");
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/b/:id/instructors", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const course = await db.course.findFirst({ where: { id: req.body.courseId ?? "", batchId: batch.id } });
    const name = req.body.name?.trim();
    if (!course || !name) return backTo(reply, `/admin/b/${batch.id}`, "اختار المادة واكتب الاسم", true);
    const role: InstructorRole = req.body.role === "ta" ? "ta" : "doctor";
    const phone = req.body.phone?.replace(/\D/g, "") || null;
    await db.instructor.create({ data: { courseId: course.id, name, role, phoneHint: phone } });
    return backTo(reply, `/admin/b/${batch.id}`, `${name} اتضاف لمادة ${course.name}`);
  });

  app.post<{ Params: { id: string; iid: string } }>("/admin/b/:id/instructors/:iid/delete", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    await db.instructor.deleteMany({ where: { id: req.params.iid, course: { batchId: batch.id } } });
    return backTo(reply, `/admin/b/${batch.id}`, "اتمسح");
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/b/:id/slots", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const course = await db.course.findFirst({ where: { id: req.body.courseId ?? "", batchId: batch.id } });
    const weekday = Number(req.body.weekday);
    const time = req.body.time ?? "";
    if (!course || !(weekday >= 1 && weekday <= 7) || !/^\d{1,2}:\d{2}$/.test(time)) return backTo(reply, `/admin/b/${batch.id}`, "بيانات المحاضرة ناقصة", true);
    await db.lectureSlot.create({ data: { batchId: batch.id, courseId: course.id, weekday, startTime: time } });
    return backTo(reply, `/admin/b/${batch.id}`, `محاضرة ${course.name} يوم ${WEEKDAYS[weekday]} اتسجلت`);
  });

  app.post<{ Params: { id: string; sid: string } }>("/admin/b/:id/slots/:sid/delete", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    await db.lectureSlot.deleteMany({ where: { id: req.params.sid, batchId: batch.id } });
    return backTo(reply, `/admin/b/${batch.id}`, "اتمسحت");
  });

  app.post<{ Params: { id: string; sid: string }; Body: Form }>("/admin/b/:id/students/:sid/role", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const student = await db.student.findFirst({ where: { id: req.params.sid, batchId: batch.id } });
    if (!student) return backTo(reply, `/admin/b/${batch.id}`, "الطالب مش موجود", true);
    const role = req.body.role === "rep" ? "rep" : "student";
    await db.student.update({ where: { id: student.id }, data: { role } });
    if (role === "rep") {
      await bot.api
        .sendMessage(student.telegramId, "🎖️ بقيت مندوب الدفعة في UniAssist. هيوصلك أي حدث محتاج تأكيد، وتقدر تصحح بالأزرار تحت كل كارت. ابعت /rephelp تشوف الأوامر.")
        .catch(() => undefined);
    }
    return backTo(reply, `/admin/b/${batch.id}`, role === "rep" ? `${student.name} بقى مندوب` : `${student.name} مبقاش مندوب`);
  });

  app.post<{ Params: { id: string; gid: string }; Body: Form }>("/admin/b/:id/groups/:gid/link", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const type: GroupType = req.body.type === "section" || req.body.type === "course" ? req.body.type : "batch";
    const updated = await db.group.updateMany({ where: { id: req.params.gid, batchId: null }, data: { batchId: batch.id, type } });
    return backTo(reply, `/admin/b/${batch.id}`, updated.count ? "الجروب اتربط. من دلوقتي رسايله بتتقري." : "الجروب ده مربوط بدفعة تانية", !updated.count);
  });

  app.post<{ Params: { id: string; gid: string } }>("/admin/b/:id/groups/:gid/unlink", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    await db.group.updateMany({ where: { id: req.params.gid, batchId: batch.id }, data: { batchId: null } });
    return backTo(reply, `/admin/b/${batch.id}`, "الجروب اتفك ربطه");
  });

  app.post<{ Params: { id: string; eid: string; action: string } }>("/admin/b/:id/events/:eid/:action", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const action = req.params.action;
    const event = await db.event.findFirst({ where: { id: req.params.eid, batchId: batch.id } });
    if (!event) return backTo(reply, `/admin/b/${batch.id}`, "الحدث مش موجود", true);
    const admin = sessionAdmin(req);
    if (action === "confirm" && event.status === "pending") {
      await confirmEvent(event.id);
      return backTo(reply, `/admin/b/${batch.id}`, "اتأكد واتبعت للدفعة");
    }
    if (action === "reject" || action === "cancel") {
      const status = action === "reject" ? "rejected" : "cancelled";
      await applyPatch(event.id, { status });
      await scheduleEventReminders(event.id);
      await db.correction.create({ data: { eventId: event.id, adminTelegramId: admin, action, before: { status: event.status }, after: { status } } });
      if (action === "cancel" && event.notifiedAt) {
        const { announceEvent } = await import("../notify/announce.js");
        await announceEvent(event.id, "cancelled", null);
      }
      return backTo(reply, `/admin/b/${batch.id}`, action === "reject" ? "اتشال" : "اتلغى وكل التنبيهات بتاعته اتشالت");
    }
    return backTo(reply, `/admin/b/${batch.id}`, "مفيش تغيير");
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/b/:id/rename", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const name = req.body.name?.trim();
    if (!name) return backTo(reply, `/admin/b/${batch.id}`, "اكتب اسم الدفعة", true);
    const year = Number(req.body.year);
    await db.batch.update({ where: { id: batch.id }, data: { name, ...(year > 2000 ? { year } : {}) } });
    return backTo(reply, `/admin/b/${batch.id}`, "الاسم اتحفظ");
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/b/:id/settings", async (req, reply) => {
    const batch = await withBatch(req, reply);
    if (!batch) return;
    const cur = parseFeatures(batch.features);
    const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
    const next = FeaturesSchema.safeParse({
      ...cur,
      solverEnabled: req.body.solverEnabled === "on",
      repConfirmAll: req.body.repConfirmAll === "on",
      solveDailyLimit: Math.max(0, Math.round(num(req.body.solveDailyLimit, cur.solveDailyLimit))),
      studyDailyLimit: Math.max(0, Math.round(num(req.body.studyDailyLimit, cur.studyDailyLimit))),
      digestHour: Math.min(23, Math.max(0, Math.round(num(req.body.digestHour, cur.digestHour)))),
      examLockBeforeMinutes: Math.max(0, Math.round(num(req.body.examLockBeforeMinutes, cur.examLockBeforeMinutes))),
    });
    if (!next.success) return backTo(reply, `/admin/b/${batch.id}`, "قيم غلط في الإعدادات", true);
    await db.batch.update({ where: { id: batch.id }, data: { features: next.data } });
    return backTo(reply, `/admin/b/${batch.id}`, "الإعدادات اتحفظت");
  });
}

function loginHelp(error?: string): string {
  const me = botUsername();
  return adminPage(
    "دخول",
    `<h1>دخول الأدمن</h1>${error ? `<div class="flash err">⚠️ ${esc(error)}</div>` : ""}
    <div class="card"><p>علشان تدخل لوحة الأدمن:</p>
    <ol><li>افتح البوت${me ? ` <a href="https://t.me/${esc(me)}" target="_blank">@${esc(me)}</a>` : ""} في تيليجرام.</li>
    <li>ابعتله: <code>/admin</code></li>
    <li>هيبعتلك لينك دخول. افتحه وهتدخل على طول (اللينك صالح 10 دقايق ولمرة واحدة).</li></ol></div>`,
    { nav: false },
  );
}
