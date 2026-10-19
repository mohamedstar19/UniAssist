import type { Batch, Course, SolverMode, Student } from "@prisma/client";
import { config } from "../config.js";
import { parseFeatures } from "../features.js";
import { fileBlock, LlmRefusalError, llmText, type ContentBlock, type Effort } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { getFile } from "../lib/storage.js";
import { formatDue, promptDate } from "../lib/time.js";
import { normalizeArabic } from "../pipeline/prefilter.js";
import { activeExamLock, remainingToday } from "./guard.js";
import { lectureMaterial, searchMaterial, snippetsForPrompt } from "./retrieve.js";
import type Anthropic from "@anthropic-ai/sdk";

export type StudentWithBatch = Student & { batch: Batch };
export type TutorMode = Extract<SolverMode, "explain" | "hint" | "solve" | "review" | "pastexam" | "plan">;

export interface UploadedFile {
  data: Buffer;
  mimeType: string;
  name?: string;
}

export interface TutorRequest {
  student: StudentWithBatch;
  mode: TutorMode;
  eventId?: string | null;
  text?: string;
  files?: UploadedFile[];
  courseId?: string | null;
}

export type TutorResult = { ok: true; text: string } | { ok: false; reason: string };

const MODE_SETTINGS: Record<TutorMode, { effort: Effort; label: string }> = {
  explain: { effort: "medium", label: "explain" },
  hint: { effort: "low", label: "hint" },
  solve: { effort: "high", label: "solve" },
  review: { effort: "high", label: "review" },
  pastexam: { effort: "high", label: "pastexam" },
  plan: { effort: "low", label: "plan" },
};

const MAX_FILE_BLOCK_BYTES = 8 * 1024 * 1024;
const CONV_TTL_SECONDS = 45 * 60;

// ---- Gate: feature flag, terms, exam lock, daily limits -------------------------------------

export async function gate(student: StudentWithBatch, mode: SolverMode): Promise<string | null> {
  const f = parseFeatures(student.batch.features);
  if (!f.solverEnabled && mode !== "ask") return "مساعد المذاكرة مقفول للدفعة دي.";
  if (!student.acceptedTermsAt) return "لازم توافق على الشروط الأول: ابعت /terms";
  if (mode !== "ask") {
    const lock = await activeExamLock(student.batch);
    if (lock) {
      const what = `${lock.event.type === "exam" ? "امتحان" : "كويز"}${lock.event.course ? ` ${lock.event.course.name}` : ""}`;
      await recordBlocked(student.id, mode, "exam_lock");
      return `🔒 فيه ${what} شغال دلوقتي، فمساعد المذاكرة واقف لحد ${formatDue(lock.until, student.batch.timezone)}.\nبالتوفيق! 🍀 بعد ما يخلص نراجعه سوا.`;
    }
  }
  const left = await remainingToday(student.id, student.batch, mode);
  if (left <= 0) {
    await recordBlocked(student.id, mode, "quota");
    return mode === "solve" || mode === "review"
      ? `خلصت عدد طلبات الحل والمراجعة النهارده (${f.solveDailyLimit} في اليوم). تقدر تستخدم /explain و /hint و /quiz، أو ترجع بكرة.`
      : "خلصت طلبات المذاكرة النهارده. نكمل بكرة 💪";
  }
  return null;
}

async function recordBlocked(studentId: string, mode: SolverMode, reason: string): Promise<void> {
  await db.solverJob.create({ data: { studentId, mode, blocked: reason } });
}

// ---- Context -------------------------------------------------------------------------------------

export function detectCourse(courses: Course[], text: string): Course | null {
  const t = normalizeArabic(text).replace(/\s+/g, " ");
  for (const c of courses) {
    const names = [c.name, c.code ?? "", ...c.aliases].map((n) => normalizeArabic(n).trim()).filter((n) => n.length >= 2);
    if (names.some((n) => t.includes(n))) return c;
  }
  return null;
}

async function eventFiles(eventId: string): Promise<{ blocks: ContentBlock[]; texts: string[]; ids: string[] }> {
  const event = await db.event.findUnique({ where: { id: eventId }, include: { revisions: true } });
  if (!event) return { blocks: [], texts: [], ids: [] };
  const msgIds = [event.createdFromMessageId, ...event.revisions.map((r) => r.fromMessageId)].filter((x): x is string => !!x);
  const media = await db.media.findMany({ where: { rawMessageId: { in: msgIds } }, take: 5, orderBy: { createdAt: "asc" } });
  const blocks: ContentBlock[] = [];
  const texts: string[] = [];
  for (const m of media) {
    if (m.sizeBytes <= MAX_FILE_BLOCK_BYTES && (m.kind === "pdf" || m.kind === "image")) {
      const block = fileBlock(await getFile(m.storageKey), m.mimeType, m.filename ?? undefined);
      if (block) {
        blocks.push(block);
        continue;
      }
    }
    if (m.extractedText) texts.push(`[${m.filename ?? m.title ?? "file"}]\n${m.extractedText.slice(0, 30_000)}`);
  }
  return { blocks, texts, ids: media.map((m) => m.id) };
}

async function upcomingForPrompt(batch: Batch): Promise<string> {
  const events = await db.event.findMany({
    where: { batchId: batch.id, status: "active", dueAt: { gte: new Date(), lte: new Date(Date.now() + 45 * 86400_000) } },
    include: { course: true },
    orderBy: { dueAt: "asc" },
  });
  if (!events.length) return "(no upcoming deadlines)";
  return events.map((e) => `- ${e.type} | ${e.course?.name ?? "?"} | ${e.title} | ${promptDate(e.dueAt!, batch.timezone)}${e.description ? ` | ${e.description.slice(0, 300)}` : ""}`).join("\n");
}

// ---- Conversation memory (for follow-up questions) ---------------------------------------------

interface Conversation {
  mode: TutorMode;
  eventId?: string | null;
  courseId?: string | null;
  messages: Anthropic.Beta.BetaMessageParam[];
}

async function saveConversation(studentId: string, conv: Conversation): Promise<void> {
  // keep the last turns and a bounded size
  let msgs = conv.messages.slice(-12);
  while (JSON.stringify(msgs).length > 150_000 && msgs.length > 2) msgs = msgs.slice(2);
  if (msgs[0]?.role !== "user") msgs = msgs.slice(1);
  await redis.set(`conv:${studentId}`, JSON.stringify({ ...conv, messages: msgs }), "EX", CONV_TTL_SECONDS);
}

export async function hasConversation(studentId: string): Promise<boolean> {
  return (await redis.exists(`conv:${studentId}`)) === 1;
}

export async function endConversation(studentId: string): Promise<void> {
  await redis.del(`conv:${studentId}`);
}

// ---- Main entry points --------------------------------------------------------------------------

export async function runTutor(req: TutorRequest): Promise<TutorResult> {
  const { student } = req;
  const blocked = await gate(student, req.mode);
  if (blocked) return { ok: false, reason: blocked };

  const batch = student.batch;
  const courses = await db.course.findMany({ where: { batchId: batch.id } });
  const event = req.eventId ? await db.event.findFirst({ where: { id: req.eventId, batchId: batch.id }, include: { course: true } }) : null;
  const course =
    (req.courseId ? courses.find((c) => c.id === req.courseId) : null) ??
    event?.course ??
    (req.text ? detectCourse(courses, req.text) : null);

  const content: ContentBlock[] = [];
  const contextParts: string[] = [`Mode: ${MODE_SETTINGS[req.mode].label}`, `Now (Cairo): ${promptDate(new Date(), batch.timezone)}`];
  if (course) contextParts.push(`Course: ${course.name}${course.code ? ` (${course.code})` : ""}`);

  let inputFileIds: string[] = [];
  if (event) {
    contextParts.push(
      `## ${event.type === "assignment" ? "Assignment" : event.type === "exam" ? "Exam" : event.type === "quiz" ? "Quiz" : "Item"}\n` +
        `Title: ${event.title}\nDue: ${event.dueAt ? promptDate(event.dueAt, batch.timezone) : "unknown"}\nDetails from the group: ${event.description ?? "(none)"}`,
    );
    const files = await eventFiles(event.id);
    inputFileIds = files.ids;
    content.push(...files.blocks);
    if (files.texts.length) contextParts.push(`## Text of the attached files\n${files.texts.join("\n\n")}`);
  }

  for (const f of req.files ?? []) {
    const block = fileBlock(f.data, f.mimeType, f.name);
    if (block) content.push(block);
  }

  // Course material
  const query = [req.text, event?.title, event?.description].filter(Boolean).join(" ");
  let snippets = query ? await searchMaterial(batch.id, course?.id ?? null, query, 8) : [];
  if (req.mode === "pastexam" && course) {
    const past = await db.materialChunk.findMany({
      where: { batchId: batch.id, courseId: course.id, media: { materialType: { in: ["past_exam", "model_answer"] } } },
      include: { media: true },
      orderBy: [{ media: { createdAt: "desc" } }, { idx: "asc" }],
      take: 40,
    });
    snippets = past.map((c) => ({ id: c.id, content: c.content, page: c.page, title: c.media.title, materialType: c.media.materialType, lectureNumber: c.media.lectureNumber, course: course.name }));
  } else if (!snippets.length && course && (req.mode === "explain" || req.mode === "plan")) {
    snippets = await lectureMaterial(batch.id, course.id, null, 15_000);
  }
  if (snippets.length) contextParts.push(`## Course material excerpts\n${snippetsForPrompt(snippets)}`);
  if (req.mode === "plan") contextParts.push(`## Upcoming deadlines and exams\n${await upcomingForPrompt(batch)}`);

  const ask =
    req.text?.trim() ||
    {
      explain: "اشرحلي المطلوب.",
      hint: "إديني تلميح أبدأ بيه.",
      solve: "حلّه معايا خطوة بخطوة.",
      review: "راجع حلي.",
      pastexam: "يلا نحل امتحان قديم.",
      plan: "اعملي خطة مذاكرة.",
    }[req.mode];
  if (req.mode === "review" && !(req.files?.length || req.text)) {
    return { ok: false, reason: "ابعت حلك (صورة أو PDF أو نص) مع /review." };
  }

  content.push({ type: "text", text: `${contextParts.join("\n\n")}\n\n## Student\n${ask}` });

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
  const result = await callTutor(student, req.mode, messages, event?.id ?? null, ask, inputFileIds);
  if (!result.ok) return result;

  // Follow-ups reuse a text-only version of this turn (files replaced by their extracted text).
  const textOnly = `${contextParts.join("\n\n")}\n\n${req.files?.length ? "[The student attached files to this message.]\n\n" : ""}## Student\n${ask}`;
  await saveConversation(student.id, {
    mode: req.mode,
    eventId: event?.id,
    courseId: course?.id,
    messages: [
      { role: "user", content: textOnly },
      { role: "assistant", content: result.text },
    ],
  });
  return result;
}

/** A follow-up message in an open study conversation ("مش فاهم الخطوة 3"). */
export async function followUp(student: StudentWithBatch, text: string, files: UploadedFile[] = []): Promise<TutorResult> {
  const raw = await redis.get(`conv:${student.id}`);
  if (!raw) return { ok: false, reason: "no_conversation" };
  const conv = JSON.parse(raw) as Conversation;
  const blocked = await gate(student, "explain");
  if (blocked) return { ok: false, reason: blocked };

  const content: ContentBlock[] = files.map((f) => fileBlock(f.data, f.mimeType, f.name)).filter((b): b is ContentBlock => !!b);
  content.push({ type: "text", text });
  const messages = [...conv.messages, { role: "user" as const, content }];
  const result = await callTutor(student, "explain", messages, conv.eventId ?? null, text, []);
  if (result.ok) {
    await saveConversation(student.id, {
      ...conv,
      messages: [...conv.messages, { role: "user", content: text }, { role: "assistant", content: result.text }],
    });
  }
  return result;
}

async function callTutor(
  student: StudentWithBatch,
  mode: TutorMode,
  messages: Anthropic.Beta.BetaMessageParam[],
  eventId: string | null,
  input: string,
  inputFiles: string[],
): Promise<TutorResult> {
  try {
    const { text, usage, truncated } = await llmText({
      model: config.MODEL_SMART,
      system: prompt("tutor"),
      messages,
      effort: MODE_SETTINGS[mode].effort,
      maxTokens: 32000,
    });
    await db.solverJob.create({
      data: { studentId: student.id, eventId, mode, input: input.slice(0, 4000), inputFiles, output: text, model: usage.model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
    });
    return { ok: true, text: truncated ? `${text}\n\n(الرد طويل واتقطع، قولي "كمّل" وأنا أكمل.)` : text };
  } catch (err) {
    if (err instanceof LlmRefusalError) {
      await recordBlocked(student.id, mode, "refusal");
      return { ok: false, reason: "معلش مش هقدر أساعد في الطلب ده." };
    }
    logger.error({ err }, "tutor call failed");
    return { ok: false, reason: "حصلت مشكلة مؤقتة، جرب تاني كمان شوية." };
  }
}
