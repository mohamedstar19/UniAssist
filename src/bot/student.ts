import { type Bot, InlineKeyboard, InputFile } from "grammy";
import { config } from "../config.js";
import { parseReminderPrefs } from "../features.js";
import { db } from "../lib/db.js";
import { getFile } from "../lib/storage.js";
import { endOfDay, endOfWeek, formatDue } from "../lib/time.js";
import { esc, eventCard, studyButtons, TYPE_LABEL } from "../notify/format.js";
import { materialLabel } from "../notify/material.js";
import { rescheduleStudent } from "../notify/reminders.js";
import { batchCourses, matchCourseByName } from "../pipeline/courses.js";
import { detectCourse, type StudentWithBatch } from "../tutor/tutor.js";
import { argText, getStudent } from "./helpers.js";

export const TERMS_TEXT = `📜 <b>قبل ما نبدأ</b>

<b>البوت بيعمل إيه:</b> بيقرأ جروبات الدفعة اللي المندوب ضافه فيها، ويطلّع منها المواعيد والأسايمنتات والملفات، ويفكّرك بيها، ويساعدك تذاكر.

<b>الخصوصية:</b>
• رسايل الجروب بتتخزن على سيرفر محمي، والكلام العادي اللي مالوش علاقة بالدراسة بيتمسح بعد 30 يوم.
• من بياناتك إنت: اسمك على تيليجرام بس، واللي بتبعته للبوت.
• مش بنبيع ولا بنشارك بياناتك مع أي حد.

<b>مساعد المذاكرة:</b>
• معمول عشان تفهم وتتمرن: شرح، تلميحات، حل خطوة بخطوة، امتحانات تجريبية، ومراجعة حلك.
• بيقف أوتوماتيك وقت أي كويز أو امتحان للدفعة.
• إنت المسؤول عن إنك تلتزم بقواعد الكلية في الأسايمنتات. اللي بتسلّمه لازم يكون شغلك وفهمك إنت.

دوس "موافق" عشان تكمل.`;

export const HELP_TEXT = `🤖 <b>أوامر UniAssist</b>

<b>المواعيد</b>
/today: إيه عليك النهارده
/week: الأسبوع ده كله
/course اسم_المادة: كل حاجة بتخص مادة
/files اسم_المادة [رقم المحاضرة]: ملفات المادة
/link: رابط أجندة الدفعة على الويب

<b>المذاكرة</b>
/explain سؤالك: شرح (أو ابعت صورة السؤال)
/hint: تلميح بس من غير حل
/solve: حل خطوة بخطوة (رد بيه على كارت أسايمنت)
/review + ملف: يراجع حلك
/quiz اسم_المادة [رقم المحاضرة]: امتحان تجريبي
/pastexam اسم_المادة: نحل امتحانات قديمة
/plan: خطة مذاكرة لحد الامتحانات

<b>الإعدادات</b>
/remind 3d 1d 3h: مواعيد التذكير (أو /remind off)
/mute اسم_المادة · /unmute اسم_المادة
/digest on|off: الملخص اليومي الصبح

وتقدر تسألني بكلام عادي: "عندي إيه الأسبوع الجاي؟" أو "الكويز بتاع Networks إمتى؟"`;

const termsKeyboard = new InlineKeyboard().text("✅ موافق", "terms:ok");

async function agendaText(s: StudentWithBatch, until: Date, title: string, courseId?: string): Promise<string> {
  const tz = s.batch.timezone;
  const events = await db.event.findMany({
    where: {
      batchId: s.batchId,
      status: "active",
      ...(courseId ? { courseId } : { courseId: { notIn: s.mutedCourseIds } }),
      dueAt: { gte: new Date(Date.now() - 60 * 60 * 1000), lte: until },
    },
    include: { course: true },
    orderBy: { dueAt: "asc" },
  });
  const undated = await db.event.findMany({
    where: { batchId: s.batchId, status: "active", dueAt: null, type: { not: "announcement" }, ...(courseId ? { courseId } : {}) },
    include: { course: true },
    take: 10,
  });
  if (!events.length && !undated.length) return `${title}\n\nمفيش حاجة 🎉`;
  const lines = [title, ""];
  for (const e of events) {
    lines.push(`${TYPE_LABEL[e.type] ?? e.type}${e.course ? ` · <b>${esc(e.course.name)}</b>` : ""}\n${esc(e.title)}\n🗓️ ${formatDue(e.dueAt, tz)}`, "");
  }
  if (undated.length) {
    lines.push("<b>ميعادها لسه مش محدد:</b>");
    for (const e of undated) lines.push(`• ${e.course ? `${esc(e.course.name)}: ` : ""}${esc(e.title)}`);
  }
  return lines.join("\n");
}

export function registerStudentHandlers(bot: Bot): void {
  const priv = bot.chatType("private");

  priv.command("start", async (ctx) => {
    const payload = ctx.match?.trim() ?? "";
    let student = await getStudent(ctx);

    if (payload.startsWith("ev_") && student) {
      const event = await db.event.findFirst({ where: { id: payload.slice(3), batchId: student.batchId }, include: { course: true } });
      if (event) {
        const kb = new InlineKeyboard();
        for (const row of studyButtons(event) ?? []) {
          for (const b of row) if (b.data) kb.text(b.text, b.data);
          kb.row();
        }
        await ctx.reply(eventCard(event, student.batch.timezone, { showRelative: true }), { parse_mode: "HTML", reply_markup: kb });
        return;
      }
    }

    if (student) {
      if (!student.acceptedTermsAt) {
        await ctx.reply(TERMS_TEXT, { parse_mode: "HTML", reply_markup: termsKeyboard });
        return;
      }
      await ctx.reply(`أهلاً ${esc(student.name)} 👋 إنت مسجل في ${esc(student.batch.name)}.\n\n${HELP_TEXT}`, { parse_mode: "HTML" });
      return;
    }

    const code = payload.replace(/^join_/, "").toUpperCase();
    const batch = code ? await db.batch.findUnique({ where: { inviteCode: code } }) : null;
    if (!batch) {
      await ctx.reply("أهلاً! 👋 ابعتلي كود الدعوة بتاع دفعتك (خده من مندوب الدفعة)، أو افتح لينك الدعوة.");
      return;
    }
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "طالب";
    student = await db.student.create({ data: { batchId: batch.id, telegramId: String(ctx.from.id), name }, include: { batch: true } });
    await ctx.reply(`تمام! سجلتك في <b>${esc(batch.name)}</b> ✅`, { parse_mode: "HTML" });
    await ctx.reply(TERMS_TEXT, { parse_mode: "HTML", reply_markup: termsKeyboard });
  });

  priv.command("terms", async (ctx) => {
    await ctx.reply(TERMS_TEXT, { parse_mode: "HTML", reply_markup: termsKeyboard });
  });

  bot.callbackQuery("terms:ok", async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery({ text: "ابعت /start الأول" });
    if (!s.acceptedTermsAt) {
      await db.student.update({ where: { id: s.id }, data: { acceptedTermsAt: new Date() } });
      await rescheduleStudent(s.id);
    }
    await ctx.answerCallbackQuery({ text: "تمام ✅" });
    await ctx.reply(`يلا بينا 🚀\n\n${HELP_TEXT}`, { parse_mode: "HTML" });
  });

  priv.command("help", (ctx) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));

  // Everything below needs a registered student.
  priv.use(async (ctx, next) => {
    const s = await getStudent(ctx);
    if (!s) {
      const text = ctx.message?.text?.trim().toUpperCase() ?? "";
      const batch = /^[A-Z0-9]{5,8}$/.test(text) ? await db.batch.findUnique({ where: { inviteCode: text } }) : null;
      if (batch && ctx.from) {
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "طالب";
        await db.student.create({ data: { batchId: batch.id, telegramId: String(ctx.from.id), name } });
        await ctx.reply(`تمام! سجلتك في <b>${esc(batch.name)}</b> ✅`, { parse_mode: "HTML" });
        await ctx.reply(TERMS_TEXT, { parse_mode: "HTML", reply_markup: termsKeyboard });
        return;
      }
      await ctx.reply("لسه مش مسجل 🙂 ابعتلي كود الدعوة بتاع دفعتك.");
      return;
    }
    if (!s.acceptedTermsAt && !ctx.callbackQuery) {
      await ctx.reply(TERMS_TEXT, { parse_mode: "HTML", reply_markup: termsKeyboard });
      return;
    }
    await next();
  });

  priv.command("today", async (ctx) => {
    const s = (await getStudent(ctx))!;
    await ctx.reply(await agendaText(s, endOfDay(s.batch.timezone), "📅 <b>النهارده</b>"), { parse_mode: "HTML" });
  });

  priv.command("week", async (ctx) => {
    const s = (await getStudent(ctx))!;
    await ctx.reply(await agendaText(s, endOfWeek(s.batch.timezone), "🗓️ <b>الـ7 أيام الجايين</b>"), { parse_mode: "HTML" });
  });

  priv.command("course", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const courses = await batchCourses(s.batchId);
    const course = matchCourseByName(courses, argText(ctx));
    if (!course) {
      await ctx.reply(`اكتب اسم المادة، مثلاً: /course ${courses[0]?.name ?? "Networks"}\n\nالمواد: ${courses.map((c) => c.name).join("، ") || "لسه مفيش"}`);
      return;
    }
    const far = new Date(Date.now() + 180 * 86400_000);
    await ctx.reply(await agendaText(s, far, `📚 <b>${esc(course.name)}</b>`, course.id), { parse_mode: "HTML" });
  });

  priv.command("files", async (ctx) => {
    const s = (await getStudent(ctx))!;
    await sendFiles(ctx, s, argText(ctx));
  });

  priv.command("link", async (ctx) => {
    const s = (await getStudent(ctx))!;
    await ctx.reply(`🌐 أجندة الدفعة ومكتبة الملفات:\n${config.PUBLIC_URL}/b/${s.batch.webToken}\n\n📆 تضيفها لـGoogle Calendar:\n${config.PUBLIC_URL}/b/${s.batch.webToken}/calendar.ics`);
  });

  priv.command("remind", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const arg = argText(ctx).toLowerCase();
    const prefs = parseReminderPrefs(s.reminderPrefs);
    if (!arg) {
      const cur = prefs.offsetsMinutes.map(fmtOffset).join(" · ") || "مقفولة";
      await ctx.reply(`التذكيرات دلوقتي: ${cur}\nغيّرها كده: /remind 3d 1d 3h (d = يوم، h = ساعة، m = دقيقة)، أو /remind off`);
      return;
    }
    const offsets = arg === "off" ? [] : parseOffsets(arg);
    if (offsets === null) {
      await ctx.reply("مش فاهم 🙏 اكتبها كده: /remind 2d 5h 30m");
      return;
    }
    await db.student.update({ where: { id: s.id }, data: { reminderPrefs: { ...prefs, offsetsMinutes: offsets } } });
    await rescheduleStudent(s.id);
    await ctx.reply(offsets.length ? `✅ هفكّرك قبل: ${offsets.map(fmtOffset).join(" · ")}` : "🔕 التذكيرات اتقفلت.");
  });

  priv.command("digest", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const on = !/off|لا|اقفل/.test(argText(ctx).toLowerCase());
    const prefs = parseReminderPrefs(s.reminderPrefs);
    await db.student.update({ where: { id: s.id }, data: { reminderPrefs: { ...prefs, digest: on } } });
    await ctx.reply(on ? "☀️ الملخص اليومي شغال." : "الملخص اليومي اتقفل.");
  });

  for (const cmd of ["mute", "unmute"] as const) {
    priv.command(cmd, async (ctx) => {
      const s = (await getStudent(ctx))!;
      const course = matchCourseByName(await batchCourses(s.batchId), argText(ctx));
      if (!course) {
        await ctx.reply(`اكتب اسم المادة: /${cmd} Physics`);
        return;
      }
      const muted = new Set(s.mutedCourseIds);
      if (cmd === "mute") muted.add(course.id);
      else muted.delete(course.id);
      await db.student.update({ where: { id: s.id }, data: { mutedCourseIds: [...muted] } });
      await rescheduleStudent(s.id);
      await ctx.reply(cmd === "mute" ? `🔕 ${course.name} اتسكتت.` : `🔔 ${course.name} رجعت.`);
    });
  }
}

/** "/files Networks 4" sends lecture 4's files; "/files Networks" lists the course library. */
export async function sendFiles(ctx: import("grammy").Context, s: StudentWithBatch, query: string, quiet = false): Promise<boolean> {
  const courses = await batchCourses(s.batchId);
  const lecture = Number(query.match(/(?:lecture|lec|محاضر[ةه]|المحاضر[ةه]|ch|chapter|شابتر)?\s*(\d{1,2})\s*$/i)?.[1] ?? NaN);
  const course = detectCourse(courses, query) ?? matchCourseByName(courses, query.replace(/\d+\s*$/, ""));
  if (!course) {
    if (!quiet) await ctx.reply(`أنهي مادة؟ مثلاً: /files ${courses[0]?.name ?? "Networks"} 4`);
    return false;
  }
  const media = await db.media.findMany({
    where: { batchId: s.batchId, courseId: course.id, ...(Number.isFinite(lecture) ? { lectureNumber: lecture } : {}) },
    orderBy: [{ lectureNumber: "asc" }, { createdAt: "asc" }],
    take: 60,
  });
  if (!media.length) {
    if (quiet) return false;
    await ctx.reply(`مفيش ملفات${Number.isFinite(lecture) ? ` للمحاضرة ${lecture}` : ""} لمادة ${course.name} لسه.`);
    return false;
  }
  if (Number.isFinite(lecture) && media.length <= 5) {
    for (const m of media) {
      await ctx.replyWithDocument(new InputFile(await getFile(m.storageKey), m.filename ?? `${m.title ?? "file"}`), {
        caption: `${course.name} · ${materialLabel(m.materialType)} ${m.lectureNumber ?? ""}`.trim(),
      });
    }
    return true;
  }
  const lines = [`📂 <b>${esc(course.name)}</b>`];
  for (const m of media) {
    const url = `${config.PUBLIC_URL}/b/${s.batch.webToken}/f/${m.id}`;
    lines.push(`• ${materialLabel(m.materialType)}${m.lectureNumber ? ` ${m.lectureNumber}` : ""}: <a href="${url}">${esc(m.title ?? m.filename ?? "ملف")}</a>`);
  }
  lines.push("", `عايز ملفات محاضرة معينة؟ /files ${course.name} 4`);
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  return true;
}

export function parseOffsets(arg: string): number[] | null {
  const tokens = arg.split(/[\s,]+/).filter(Boolean);
  const out: number[] = [];
  for (const t of tokens) {
    const m = t.match(/^(\d+(?:\.\d+)?)(d|h|m|يوم|ساعة|ساعه|دقيقة|دقيقه)$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2]!;
    const mins = unit === "d" || unit === "يوم" ? n * 1440 : unit === "h" || unit.startsWith("ساع") ? n * 60 : n;
    if (mins < 5 || mins > 30 * 1440) return null;
    out.push(Math.round(mins));
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

export function fmtOffset(mins: number): string {
  if (mins % 1440 === 0) return `${mins / 1440} يوم`;
  if (mins % 60 === 0) return `${mins / 60} ساعة`;
  return `${mins} دقيقة`;
}
