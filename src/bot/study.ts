import { type Bot, type Context, InlineKeyboard } from "grammy";
import { db } from "../lib/db.js";
import { esc } from "../notify/format.js";
import { batchCourses, matchCourseByName } from "../pipeline/courses.js";
import { answerQuestion } from "../tutor/ask.js";
import { answerQuiz, quizScore, startQuiz, type QuizState } from "../tutor/quiz.js";
import { detectCourse, endConversation, followUp, hasConversation, runTutor, type StudentWithBatch, type TutorMode, type UploadedFile } from "../tutor/tutor.js";
import { argText, eventIdFromReply, filesFromMessage, getStudent, sendAnswer, stashFiles, tutorKeyboard, unstashFiles, withTyping } from "./helpers.js";
import { sendFiles } from "./student.js";

const LETTERS = ["أ", "ب", "ج", "د", "هـ", "و"]; // quizzes are limited to 6 options (see quiz.ts)

async function runAndReply(ctx: Context, s: StudentWithBatch, mode: TutorMode, opts: { eventId?: string | null; text?: string; files?: UploadedFile[]; courseId?: string | null }) {
  const result = await withTyping(ctx, () => runTutor({ student: s, mode, ...opts }));
  if (!result.ok) {
    await ctx.reply(result.reason);
    return;
  }
  await sendAnswer(ctx, result.text, tutorKeyboard());
}

function quizQuestionMessage(sessionId: string, state: QuizState): { text: string; keyboard: InlineKeyboard } {
  const i = state.current;
  const q = state.questions[i]!;
  const text = `🧠 <b>${esc(state.courseName)}: سؤال ${i + 1} من ${state.questions.length}</b>\n\n${esc(q.question)}\n\n${q.options.map((o, k) => `${LETTERS[k]}) ${esc(o)}`).join("\n")}`;
  const keyboard = new InlineKeyboard();
  q.options.forEach((_, k) => keyboard.text(LETTERS[k]!, `qa:${sessionId}:${i}:${k}`));
  return { text, keyboard };
}

async function beginQuiz(ctx: Context, s: StudentWithBatch, opts: Parameters<typeof startQuiz>[1]) {
  const res = await withTyping(ctx, () => startQuiz(s, opts));
  if (!res.ok) {
    await ctx.reply(res.reason);
    return;
  }
  const { text, keyboard } = quizQuestionMessage(res.sessionId, res.state);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export function registerStudyHandlers(bot: Bot): void {
  const priv = bot.chatType("private");

  for (const mode of ["explain", "hint", "solve", "review", "plan"] as const) {
    priv.command(mode, async (ctx) => {
      const s = (await getStudent(ctx))!;
      const files = await filesFromMessage(ctx);
      const replyFiles = !files.length && ctx.message.reply_to_message ? await filesFromReply(ctx) : [];
      const eventId = eventIdFromReply(ctx);
      const text = argText(ctx);
      if (!eventId && !files.length && !replyFiles.length && !text && mode !== "plan") {
        await ctx.reply(
          mode === "review"
            ? "ابعت حلك (صورة أو PDF) واكتب في الكابشن /review، أو رد بـ/review على الملف."
            : `اكتب سؤالك بعد الأمر، مثلاً: /${mode} إزاي أحسب الـsubnet mask؟\nأو ابعت صورة السؤال، أو رد بـ/${mode} على كارت أسايمنت.`,
        );
        return;
      }
      await runAndReply(ctx, s, mode, { eventId, text, files: [...files, ...replyFiles] });
    });
  }

  priv.command("pastexam", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const courses = await batchCourses(s.batchId);
    const arg = argText(ctx);
    const course = matchCourseByName(courses, arg) ?? detectCourse(courses, arg);
    if (!course) {
      await ctx.reply(`أنهي مادة؟ مثلاً: /pastexam ${courses[0]?.name ?? "Networks"}`);
      return;
    }
    await runAndReply(ctx, s, "pastexam", { courseId: course.id, text: arg });
  });

  priv.command("quiz", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const courses = await batchCourses(s.batchId);
    const arg = argText(ctx);
    const lecture = arg.match(/(\d{1,2})\s*$/)?.[1];
    const course = matchCourseByName(courses, arg.replace(/(lecture|lec|محاضر[ةه])?\s*\d{1,2}\s*$/i, "").trim()) ?? detectCourse(courses, arg);
    if (!course) {
      const kb = new InlineKeyboard();
      courses.slice(0, 12).forEach((c, i) => {
        kb.text(c.name, `q:c:${c.id}:0`);
        if (i % 2 === 1) kb.row();
      });
      await ctx.reply("أمتحنك في أنهي مادة؟ (أو اكتب: /quiz Networks 4 لمحاضرة معينة)", { reply_markup: kb });
      return;
    }
    await beginQuiz(ctx, s, { courseId: course.id, lectureNumber: lecture ? Number(lecture) : null });
  });

  // ---- Buttons ------------------------------------------------------------------------------

  bot.callbackQuery(/^t:(explain|hint|solve|plan):(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery({ text: "ابعت /start الأول" });
    await ctx.answerCallbackQuery();
    await runAndReply(ctx, s, ctx.match[1] as TutorMode, { eventId: ctx.match[2] });
  });

  bot.callbackQuery(/^q:ev:(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const event = await db.event.findFirst({ where: { id: ctx.match[1], batchId: s.batchId } });
    if (!event?.courseId) return ctx.reply("مش عارف الحدث ده تبع أنهي مادة. جرب /quiz اسم_المادة");
    await beginQuiz(ctx, s, { courseId: event.courseId, eventId: event.id });
  });

  bot.callbackQuery(/^q:c:(\w+):(\d+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const lecture = Number(ctx.match[2]);
    await beginQuiz(ctx, s, { courseId: ctx.match[1]!, lectureNumber: lecture || null });
  });

  bot.callbackQuery(/^qa:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    const res = await answerQuiz(s.id, ctx.match[1]!, Number(ctx.match[2]), Number(ctx.match[3]));
    if (!res) return ctx.answerCallbackQuery({ text: "السؤال ده اتجاوب خلاص" });
    await ctx.answerCallbackQuery({ text: res.correct ? "✅ صح" : "❌ غلط" });
    const q = res.question;
    const verdict = res.correct
      ? `✅ <b>صح!</b>`
      : `❌ <b>الإجابة الصح: ${LETTERS[q.correctIndex]}) ${esc(q.options[q.correctIndex] ?? "")}</b>`;
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await ctx.reply(`${verdict}\n${esc(q.explanation)}\n<i>📖 ${esc(q.source)}</i>`, { parse_mode: "HTML" });
    if (!res.finished) {
      const { text, keyboard } = quizQuestionMessage(ctx.match[1]!, res.state);
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    }
    const score = quizScore(res.state);
    const total = res.state.questions.length;
    const wrong = res.state.questions.filter((qq, i) => res.state.answers[i] !== qq.correctIndex).map((qq) => qq.source);
    const msg =
      `🏁 <b>النتيجة: ${score} من ${total}</b> ${score === total ? "🔥" : score >= total * 0.6 ? "👏" : "💪"}\n` +
      (wrong.length ? `راجع: ${esc([...new Set(wrong)].join("، "))}` : "ممتاز، كمّل كده!");
    const kb = new InlineKeyboard().text("🔁 كويز تاني", `q:again:${ctx.match[1]}`);
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery(/^q:again:(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const prev = await db.studySession.findFirst({ where: { id: ctx.match[1], studentId: s.id } });
    const course = prev ? await db.course.findFirst({ where: { batchId: s.batchId, name: (prev.state as unknown as QuizState).courseName } }) : null;
    if (!course) return ctx.reply("اكتب /quiz اسم_المادة");
    await beginQuiz(ctx, s, { courseId: course.id });
  });

  bot.callbackQuery("conv:end", async (ctx) => {
    const s = await getStudent(ctx);
    if (s) await endConversation(s.id);
    await ctx.answerCallbackQuery({ text: "👍" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
  });

  bot.callbackQuery("conv:simpler", async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const res = await withTyping(ctx, () => followUp(s, "اشرحها بشكل أبسط، بمثال من الحياة لو ينفع."));
    if (!res.ok) return ctx.reply(res.reason === "no_conversation" ? "المحادثة خلصت، ابعت سؤالك تاني." : res.reason);
    await sendAnswer(ctx, res.text, tutorKeyboard());
  });

  bot.callbackQuery(/^f:(explain|hint|solve|review):(\w+)$/, async (ctx) => {
    const s = await getStudent(ctx);
    if (!s) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    const stash = await unstashFiles(ctx.match[2]!, s.id);
    if (!stash) return ctx.reply("الملف ده قديم، ابعته تاني.");
    await runAndReply(ctx, s, ctx.match[1] as TutorMode, { files: stash.files, text: stash.caption });
  });

  // ---- Files sent without a command --------------------------------------------------------------

  priv.on(["message:photo", "message:document"], async (ctx) => {
    const s = (await getStudent(ctx))!;
    // "/review" (or /explain, /hint, /solve) written in the caption of the file
    const cap = ctx.message.caption?.match(/^\/(explain|hint|solve|review)(?:@\w+)?\s*([\s\S]*)$/);
    if (cap) {
      const files = await filesFromMessage(ctx);
      return runAndReply(ctx, s, cap[1] as TutorMode, { files, text: cap[2]!.trim() });
    }
    if (await hasConversation(s.id)) {
      const files = await filesFromMessage(ctx);
      const res = await withTyping(ctx, () => followUp(s, ctx.message.caption || "بص على الملف ده.", files));
      if (res.ok) return sendAnswer(ctx, res.text, tutorKeyboard());
    }
    const key = await stashFiles(s.id, ctx);
    if (!key) return;
    const kb = new InlineKeyboard()
      .text("📖 اشرح", `f:explain:${key}`)
      .text("💡 تلميح", `f:hint:${key}`)
      .row()
      .text("✍️ حل خطوة بخطوة", `f:solve:${key}`)
      .text("🔎 راجع حلي", `f:review:${key}`);
    await ctx.reply("تحب أعمل إيه بالملف ده؟", { reply_markup: kb });
  });

  // ---- Free text -----------------------------------------------------------------------------------

  priv.on("message:text", async (ctx) => {
    const s = (await getStudent(ctx))!;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return ctx.reply("أمر مش معروف. ابعت /help");

    // "ابعتلي سلايدات lecture 4 بتاعة Networks"
    if (/(ابعت|ابعتلي|هات|عايز|عاوز|send)/i.test(text) && /(سلايد|ملف|ملفات|شيت|pdf|slides|sheet|lecture|محاضر)/i.test(text)) {
      const sent = await sendFiles(ctx, s, text, true);
      if (sent) return;
    }

    if (await hasConversation(s.id)) {
      const res = await withTyping(ctx, () => followUp(s, text));
      if (res.ok) return sendAnswer(ctx, res.text, tutorKeyboard());
      if (res.reason !== "no_conversation") return ctx.reply(res.reason);
    }

    const answer = await withTyping(ctx, () => answerQuestion(s, text));
    await sendAnswer(ctx, answer);
  });
}

async function filesFromReply(ctx: Context): Promise<UploadedFile[]> {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return [];
  const fake = { message: reply } as unknown as Context;
  return filesFromMessage(fake);
}
