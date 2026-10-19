import { randomBytes } from "node:crypto";
import type { GroupType, InstructorRole } from "@prisma/client";
import { type Bot, type Context } from "grammy";
import { config } from "../config.js";
import { FeaturesSchema, parseFeatures } from "../features.js";
import { db } from "../lib/db.js";
import { redis } from "../lib/redis.js";
import { esc, eventCard, repButtons } from "../notify/format.js";
import { scheduleEventReminders } from "../notify/reminders.js";
import { batchCourses, matchCourseByName } from "../pipeline/courses.js";
import { applyPatch, confirmEvent, resolveProposedChange } from "../pipeline/events.js";
import { applyRepCorrection, type CorrectionActor } from "../pipeline/correction.js";
import { argText, eventIdFromReply, getStudent, isAdmin, isRep, newCode } from "./helpers.js";

/** "a | b | c" → ["a","b","c"] */
function fields(ctx: Context): string[] {
  return argText(ctx).split("|").map((x) => x.trim());
}

async function repOrAdmin(ctx: Context) {
  const s = await getStudent(ctx);
  if (isAdmin(ctx) || isRep(s)) return s;
  await ctx.reply("الأمر ده للمندوب أو الأدمن بس.");
  return undefined;
}

/** The batch a rep/admin command applies to: the rep's own batch, or an invite code given by an admin. */
async function targetBatch(ctx: Context, code?: string) {
  if (code) return db.batch.findUnique({ where: { inviteCode: code.toUpperCase() } });
  const s = await getStudent(ctx);
  return s ? db.batch.findUnique({ where: { id: s.batchId } }) : null;
}

/**
 * Fields of a "a | b | c" command plus its batch. A rep works on their own batch;
 * an admin who isn't a student of a batch starts the command with the invite code.
 */
async function batchAndFields(ctx: Context) {
  const all = fields(ctx);
  const s = await getStudent(ctx);
  if (s && isRep(s)) return { batch: await db.batch.findUnique({ where: { id: s.batchId } }), rest: all };
  if (isAdmin(ctx)) {
    const byCode = all[0] ? await db.batch.findUnique({ where: { inviteCode: all[0].toUpperCase() } }) : null;
    if (byCode) return { batch: byCode, rest: all.slice(1) };
    if (s) return { batch: await db.batch.findUnique({ where: { id: s.batchId } }), rest: all };
  }
  return { batch: null, rest: all };
}

const ADMIN_CODE_HINT = "\n(كأدمن من غير دفعة: ابدأ بكود الدعوة، مثلاً /addcourse ABC123 | Networks)";

const REP_HELP = `🛠️ <b>أوامر المندوب</b>
/pending: الأحداث اللي مستنية تأكيدك
/addcourse الاسم | الكود | اسم تاني، اسم تالت
/instructor المادة | اسم الدكتور | doctor أو ta | رقم الموبايل
/lecture المادة | اليوم (1=الاتنين … 7=الحد) | 10:30
/fix (رد على كارت حدث) التصحيح
/batchinfo: كود الدعوة ولينك الأجندة
وفي الجروب (تيليجرام): /linkgroup كود_الدعوة`;

const ADMIN_HELP = `👑 <b>أوامر الأدمن</b>
/newbatch الجامعة | الكلية | اسم الدفعة | السنة
/groups: الجروبات اللي البوت شايفها ومش مربوطة
/link رقم_الجروب | كود_الدعوة | batch أو section أو course
/makerep كود_الدعوة | telegram_id   (المندوب يعرف الـID بتاعه بـ /myid)
/flag كود_الدعوة | المفتاح | القيمة   (مثلاً solverEnabled | false)
/stats: أرقام سريعة
/wareset: فك ربط رقم واتساب وربط رقم جديد (QR)
وفي قناة الدفعة: /linkchannel كود_الدعوة`;

/** The correction actor for the sender, or null when they are neither rep nor admin. */
async function correctionActor(ctx: Context): Promise<CorrectionActor | null> {
  const s = await getStudent(ctx);
  if (isAdmin(ctx)) return { studentId: s?.id ?? null, batchId: null, adminTelegramId: String(ctx.from!.id) };
  if (isRep(s)) return { studentId: s!.id, batchId: s!.batchId };
  return null;
}

export function registerManageHandlers(bot: Bot): void {
  const priv = bot.chatType("private");

  // Text after pressing ✏️ on an event card (runs before the student registration gate, so admins work too).
  priv.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const eventId = await redis.get(`edit:${ctx.from.id}`);
    if (!eventId) return next();
    const actor = await correctionActor(ctx);
    if (!actor) return next();
    await redis.del(`edit:${ctx.from.id}`);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    await ctx.reply(await applyRepCorrection(actor, eventId, ctx.message.text));
  });

  // Anyone (registered or not) can get their Telegram id: needed for ADMIN_TELEGRAM_IDS and /makerep.
  priv.command("myid", async (ctx) => {
    await ctx.reply(`الـTelegram ID بتاعك:\n<code>${ctx.from.id}</code>\n(دوس عليه علشان تنسخه)`, { parse_mode: "HTML" });
  });

  // "/fix <correction>" in reply to an event card
  priv.command("fix", async (ctx, next) => {
    const actor = await correctionActor(ctx);
    if (!actor) return next();
    const eventId = eventIdFromReply(ctx);
    if (!eventId) return ctx.reply("رد بـ/fix على كارت الحدث واكتب التصحيح، مثلاً: /fix ده إعلان مش كويز");
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    await ctx.reply(await applyRepCorrection(actor, eventId, argText(ctx)));
  });

  priv.command("rephelp", async (ctx) => {
    if (await repOrAdmin(ctx)) await ctx.reply(REP_HELP, { parse_mode: "HTML" });
  });
  priv.command("adminhelp", async (ctx) => {
    if (isAdmin(ctx)) await ctx.reply(ADMIN_HELP, { parse_mode: "HTML" });
  });

  // ---- Rep ---------------------------------------------------------------------------------------

  priv.command("batchinfo", async (ctx) => {
    if (!(await repOrAdmin(ctx))) return;
    const batch = await targetBatch(ctx, argText(ctx) || undefined);
    if (!batch) return ctx.reply("مش لاقي الدفعة.");
    const me = bot.botInfo.username;
    await ctx.reply(
      `🎓 <b>${esc(batch.name)}</b>\nكود الدعوة: <code>${batch.inviteCode}</code>\nلينك التسجيل: https://t.me/${me}?start=join_${batch.inviteCode}\n` +
        `الأجندة: ${config.PUBLIC_URL}/b/${batch.webToken}\nالقناة: ${batch.channelId ?? "مش مربوطة"}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  priv.command("pending", async (ctx) => {
    const s = await repOrAdmin(ctx);
    if (s === undefined) return;
    const where = s ? { batchId: s.batchId, status: "pending" as const } : { status: "pending" as const };
    const events = await db.event.findMany({ where, include: { course: true, batch: true }, orderBy: { createdAt: "asc" }, take: 10 });
    if (!events.length) return ctx.reply("مفيش حاجة مستنية 👌");
    for (const e of events) {
      const kb = { inline_keyboard: (repButtons(e.id) ?? []).map((r) => r.map((b) => ({ text: b.text, callback_data: b.data! }))) };
      await ctx.reply(eventCard(e, e.batch.timezone, { header: "🕵️ <b>مستني تأكيد</b>" }), { parse_mode: "HTML", reply_markup: kb });
    }
  });

  priv.command("addcourse", async (ctx) => {
    const s = await repOrAdmin(ctx);
    if (s === undefined) return;
    const { batch, rest } = await batchAndFields(ctx);
    const [name, code, aliases] = rest;
    if (!name || !batch) return ctx.reply("اكتبها كده: /addcourse Computer Networks | CS301 | نتوركس، networks، شبكات" + ADMIN_CODE_HINT);
    const course = await db.course.upsert({
      where: { batchId_name: { batchId: batch.id, name } },
      create: { batchId: batch.id, name, code: code || null, aliases: splitList(aliases) },
      update: { code: code || undefined, aliases: splitList(aliases) },
    });
    await ctx.reply(`✅ المادة اتضافت: ${course.name}${course.code ? ` (${course.code})` : ""}\nأسماء تانية: ${course.aliases.join("، ") || "-"}`);
  });

  priv.command("instructor", async (ctx) => {
    const s = await repOrAdmin(ctx);
    if (s === undefined) return;
    const { batch, rest } = await batchAndFields(ctx);
    const [courseName, name, role, phone] = rest;
    const course = batch && courseName ? matchCourseByName(await batchCourses(batch.id), courseName) : null;
    if (!course || !name) return ctx.reply("اكتبها كده: /instructor Networks | د. أحمد علي | doctor | 01012345678" + ADMIN_CODE_HINT);
    const r: InstructorRole = role?.toLowerCase() === "ta" ? "ta" : "doctor";
    await db.instructor.create({ data: { courseId: course.id, name, role: r, phoneHint: phone ? phone.replace(/\D/g, "") : null } });
    await ctx.reply(`✅ ${name} اتضاف لمادة ${course.name}. رسايله هتاخد أولوية لو حصل تعارض.`);
  });

  priv.command("lecture", async (ctx) => {
    const s = await repOrAdmin(ctx);
    if (s === undefined) return;
    const { batch, rest } = await batchAndFields(ctx);
    const [courseName, day, time] = rest;
    const course = batch && courseName ? matchCourseByName(await batchCourses(batch.id), courseName) : null;
    const weekday = Number(day);
    if (!course || !(weekday >= 1 && weekday <= 7) || !/^\d{1,2}:\d{2}$/.test(time ?? "")) {
      return ctx.reply("اكتبها كده: /lecture Networks | 3 | 10:30   (1=الاتنين، 2=التلات، … 6=السبت، 7=الحد)" + ADMIN_CODE_HINT);
    }
    await db.lectureSlot.create({ data: { batchId: batch!.id, courseId: course.id, weekday, startTime: time! } });
    await ctx.reply(`✅ محاضرة ${course.name} اتسجلت. كده "المحاضرة الجاية" هتتفهم صح.`);
  });

  // ---- Rep buttons on event cards --------------------------------------------------------------

  bot.callbackQuery(/^ev:(ok|no|edit):(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!isAdmin(ctx) && !isRep(s)) return ctx.answerCallbackQuery({ text: "للمندوب بس" });
    const [, action, eventId] = ctx.match;
    const event = await db.event.findUnique({ where: { id: eventId } });
    if (!event || (s && !isAdmin(ctx) && event.batchId !== s.batchId)) return ctx.answerCallbackQuery({ text: "مش لاقيه" });

    if (action === "ok") {
      if (event.status !== "pending") return ctx.answerCallbackQuery({ text: "اتحسم قبل كده" });
      await confirmEvent(event.id);
      await ctx.answerCallbackQuery({ text: "✅ اتبعت للدفعة" });
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      await ctx.reply("✅ اتأكد واتبعت للدفعة.");
    } else if (action === "no") {
      await applyPatch(event.id, { status: "rejected" });
      await scheduleEventReminders(event.id);
      await db.correction.create({
        data: { eventId: event.id, studentId: s?.id ?? null, adminTelegramId: isAdmin(ctx) ? String(ctx.from.id) : null, action: "reject", before: { status: event.status }, after: { status: "rejected" } },
      });
      await ctx.answerCallbackQuery({ text: "🗑️ اتشال" });
      await ctx.editMessageReplyMarkup().catch(() => undefined);
    } else {
      await redis.set(`edit:${ctx.from.id}`, event.id, "EX", 1800);
      await ctx.answerCallbackQuery();
      await ctx.reply("✏️ اكتب التصحيح بكلامك، مثلاً:\n• الميعاد الصح الخميس 2 الضهر\n• ده إعلان مش كويز\n• المادة Networks\n• ده اتلغى");
    }
  });

  bot.callbackQuery(/^chg:(ok|no):(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!isAdmin(ctx) && !isRep(s)) return ctx.answerCallbackQuery({ text: "للمندوب بس" });
    const msg = await resolveProposedChange(ctx.match[2]!, ctx.match[1] === "ok", isAdmin(ctx) ? null : s!.batchId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await ctx.reply(msg);
  });

  // ---- Admin -----------------------------------------------------------------------------------

  priv.command("newbatch", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [university, facultyName, name, year] = fields(ctx);
    if (!university || !facultyName || !name) return ctx.reply("اكتبها كده: /newbatch جامعة القاهرة | كلية الهندسة | هندسة اتصالات - تالتة | 2026");
    const faculty =
      (await db.faculty.findFirst({ where: { university, name: facultyName } })) ??
      (await db.faculty.create({ data: { university, name: facultyName } }));
    const batch = await db.batch.create({
      data: { facultyId: faculty.id, name, year: Number(year) || new Date().getFullYear(), inviteCode: newCode(6), webToken: randomBytes(12).toString("base64url") },
    });
    const me = bot.botInfo.username;
    await ctx.reply(
      `✅ الدفعة اتعملت: <b>${esc(batch.name)}</b>\nكود الدعوة: <code>${batch.inviteCode}</code>\nلينك التسجيل: https://t.me/${me}?start=join_${batch.inviteCode}\nالأجندة: ${config.PUBLIC_URL}/b/${batch.webToken}\n\n` +
        `الخطوات الجاية:\n1) /makerep ${batch.inviteCode} | telegram_id_بتاع_المندوب\n2) ضيف المواد: /addcourse\n3) اربط الجروبات: /groups ثم /link\n4) ضيف البوت أدمن في قناة الدفعة واكتب فيها /linkchannel ${batch.inviteCode}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  priv.command("groups", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const groups = await db.group.findMany({ orderBy: { createdAt: "desc" }, take: 40, include: { batch: true } });
    if (!groups.length) return ctx.reply("البوت/الرقم لسه مش شايف أي جروب. ضيفهم الأول.");
    const lines = groups.map((g) => `• [${g.source}] ${esc(g.title ?? "?")}\n  <code>${g.id}</code> → ${g.batch ? esc(g.batch.name) : "❗ مش مربوط"}`);
    await ctx.reply(`${lines.join("\n")}\n\nاربط بـ: /link رقم_الجروب | كود_الدعوة | batch`, { parse_mode: "HTML" });
  });

  priv.command("link", async (ctx, next) => {
    // Without "|" arguments this is the students' /link (agenda link).
    if (!isAdmin(ctx) || !ctx.match.includes("|")) return next();
    const [groupId, code, type] = fields(ctx);
    const batch = code ? await db.batch.findUnique({ where: { inviteCode: code.toUpperCase() } }) : null;
    const group = groupId ? await db.group.findUnique({ where: { id: groupId } }) : null;
    if (!batch || !group) return ctx.reply("اكتبها كده: /link رقم_الجروب | كود_الدعوة | batch");
    const t: GroupType = type === "section" || type === "course" ? type : "batch";
    await db.group.update({ where: { id: group.id }, data: { batchId: batch.id, type: t } });
    await ctx.reply(`✅ ${group.title ?? group.externalId} اتربط بـ${batch.name}. من دلوقتي رسايله بتتقري.`);
  });

  priv.command("makerep", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [code, tgId] = fields(ctx);
    const batch = code ? await db.batch.findUnique({ where: { inviteCode: code.toUpperCase() } }) : null;
    if (!batch || !tgId) return ctx.reply("اكتبها كده: /makerep كود_الدعوة | telegram_id\n(المندوب يسجل في البوت الأول بكود الدعوة)");
    const student = await db.student.findUnique({ where: { telegramId: tgId } });
    if (!student || student.batchId !== batch.id) return ctx.reply("الشخص ده مش مسجل في الدفعة دي. خليه يسجل الأول.");
    await db.student.update({ where: { id: student.id }, data: { role: "rep" } });
    await ctx.reply(`✅ ${student.name} بقى مندوب ${batch.name}.`);
    await bot.api.sendMessage(tgId, `🎖️ بقيت مندوب الدفعة في UniAssist.\n\n${REP_HELP}`, { parse_mode: "HTML" }).catch(() => undefined);
  });

  priv.command("flag", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [code, key, value] = fields(ctx);
    const batch = code ? await db.batch.findUnique({ where: { inviteCode: code.toUpperCase() } }) : null;
    if (!batch || !key) {
      const keys = Object.keys(FeaturesSchema.shape).join(", ");
      return ctx.reply(`اكتبها كده: /flag كود_الدعوة | solverEnabled | false\nالمفاتيح: ${keys}`);
    }
    const parsedValue = value === "true" ? true : value === "false" ? false : Number.isFinite(Number(value)) ? Number(value) : value;
    const next = { ...parseFeatures(batch.features), [key]: parsedValue };
    const check = FeaturesSchema.safeParse(next);
    if (!check.success) return ctx.reply(`قيمة غلط: ${check.error.issues[0]?.message}`);
    await db.batch.update({ where: { id: batch.id }, data: { features: check.data } });
    await ctx.reply(`✅ ${key} = ${JSON.stringify(parsedValue)} لـ${batch.name}`);
  });

  priv.command("wareset", async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!config.WHATSAPP_ENABLED) return ctx.reply("واتساب مقفول في الإعدادات (WHATSAPP_ENABLED).");
    await ctx.reply("🔄 بفك ربط الرقم الحالي… هيوصلك QR جديد خلال ثواني.");
    const { resetWhatsApp } = await import("../ingest/whatsapp.js");
    await resetWhatsApp();
  });

  priv.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const since = new Date(Date.now() - 7 * 86400_000);
    const [students, msgs, classified, events, pending, jobs, tokens] = await Promise.all([
      db.student.count(),
      db.rawMessage.count({ where: { createdAt: { gte: since } } }),
      db.rawMessage.groupBy({ by: ["classification"], where: { createdAt: { gte: since } }, _count: true }),
      db.event.count({ where: { createdAt: { gte: since } } }),
      db.event.count({ where: { status: "pending" } }),
      db.solverJob.groupBy({ by: ["mode"], where: { createdAt: { gte: since } }, _count: true }),
      db.solverJob.aggregate({ where: { createdAt: { gte: since } }, _sum: { tokensIn: true, tokensOut: true } }),
    ]);
    const cls = classified.map((c) => `${c.classification ?? "pending"}: ${c._count}`).join(" · ");
    const modes = jobs.map((j) => `${j.mode}: ${j._count}`).join(" · ");
    await ctx.reply(
      `📊 آخر 7 أيام\nطلبة مسجلين: ${students}\nرسايل: ${msgs} (${cls})\nأحداث جديدة: ${events} · مستنية تأكيد: ${pending}\nطلبات المذاكرة: ${modes || "0"}\n` +
        `Tokens: in ${tokens._sum.tokensIn ?? 0} / out ${tokens._sum.tokensOut ?? 0}`,
    );
  });

  // ---- Linking groups and channels from inside them ----------------------------------------------

  bot.chatType(["group", "supergroup"]).command("linkgroup", async (ctx) => {
    const code = argText(ctx).toUpperCase();
    const batch = code ? await db.batch.findUnique({ where: { inviteCode: code } }) : null;
    const s = await getStudent(ctx);
    const allowed = isAdmin(ctx) || (isRep(s) && s!.batchId === batch?.id);
    if (!batch || !allowed) return ctx.reply("لازم المندوب أو الأدمن يكتب: /linkgroup كود_الدعوة");
    await db.group.upsert({
      where: { source_externalId: { source: "telegram", externalId: String(ctx.chat.id) } },
      create: { source: "telegram", externalId: String(ctx.chat.id), title: ctx.chat.title, batchId: batch.id },
      update: { batchId: batch.id, title: ctx.chat.title },
    });
    await ctx.reply(`✅ الجروب اتربط بـ${batch.name}. هقرأ الرسايل من هنا ومش هتكلم في الجروب تاني.`);
  });

  bot.on("channel_post:text", async (ctx, next) => {
    const m = ctx.channelPost.text.match(/^\/linkchannel(?:@\w+)?\s+([A-Za-z0-9]+)/);
    if (!m) return next();
    const batch = await db.batch.findUnique({ where: { inviteCode: m[1]!.toUpperCase() } });
    if (!batch) return;
    await db.batch.update({ where: { id: batch.id }, data: { channelId: String(ctx.chat.id) } });
    await ctx.api.deleteMessage(ctx.chat.id, ctx.channelPost.message_id).catch(() => undefined);
    await ctx.api.sendMessage(ctx.chat.id, `✅ القناة دي بقت قناة ${batch.name}. كل الأحداث الجديدة هتتنزل هنا.`);
  });
}

function splitList(s?: string): string[] {
  return (s ?? "").split(/[,،]/).map((x) => x.trim()).filter(Boolean);
}
