import { config } from "../config.js";
import { LlmRefusalError, llmText } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { promptDate } from "../lib/time.js";
import { activeExamLock } from "./guard.js";
import { searchMaterial, snippetsForPrompt } from "./retrieve.js";
import { detectCourse, gate, type StudentWithBatch } from "./tutor.js";

/** Free-text question ("عندي إيه الأسبوع الجاي؟", "الدكتور قال إيه عن المشروع؟"), answered from stored data only. */
export async function answerQuestion(student: StudentWithBatch, question: string): Promise<string> {
  const blocked = await gate(student, "ask");
  if (blocked) return blocked;
  const batch = student.batch;
  const tz = batch.timezone;
  const courses = await db.course.findMany({ where: { batchId: batch.id } });
  const course = detectCourse(courses, question);

  const events = await db.event.findMany({
    where: {
      batchId: batch.id,
      status: { in: ["active", "cancelled"] },
      ...(course ? { courseId: course.id } : {}),
      OR: [{ dueAt: { gte: new Date(Date.now() - 7 * 86400_000) } }, { dueAt: null, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }],
    },
    include: { course: true, revisions: { orderBy: { changedAt: "asc" } } },
    orderBy: { dueAt: "asc" },
    take: 60,
  });
  const agenda = events.length
    ? events
        .map((e) => {
          const changes = e.revisions.filter((r) => r.field === "dueAt" || r.field === "status");
          return (
            `- [${e.status}] ${e.type} | ${e.course?.name ?? "?"} | ${e.title} | due: ${e.dueAt ? promptDate(e.dueAt, tz) : "unknown"}` +
            (e.description ? `\n  details: ${e.description.slice(0, 600)}` : "") +
            (changes.length ? `\n  history: ${changes.map((r) => `${r.field} ${r.oldValue ?? "?"} → ${r.newValue ?? "?"}`).join("; ")}` : "")
          );
        })
        .join("\n")
    : "(empty)";

  const recent = await db.rawMessage.findMany({
    where: {
      group: { batchId: batch.id },
      classification: { in: ["announcement", "assignment", "quiz", "exam", "schedule_change"] },
      sentAt: { gte: new Date(Date.now() - 21 * 86400_000) },
    },
    orderBy: { sentAt: "desc" },
    take: 25,
  });
  const messages = recent.length
    ? recent.map((m) => `- ${promptDate(m.sentAt, tz)} ${m.senderName ?? ""}: ${(m.text ?? "(file)").slice(0, 400)}`).join("\n")
    : "(none)";

  const lock = await activeExamLock(batch);
  const snippets = lock ? [] : await searchMaterial(batch.id, course?.id ?? null, question, 4);

  const context = [
    `Now (Cairo): ${promptDate(new Date(), tz)}`,
    lock ? `STUDY LOCK: a ${lock.event.type} is running until ${promptDate(lock.until, tz)}.` : null,
    `## Agenda${course ? ` (${course.name})` : ""}\n${agenda}`,
    `## Recent official messages\n${messages}`,
    snippets.length ? `## Course material excerpts\n${snippetsForPrompt(snippets)}` : null,
    `## Question\n${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { text, usage } = await llmText({
      model: config.MODEL_FAST,
      system: prompt("ask"),
      messages: [{ role: "user", content: context }],
      maxTokens: 4000,
      effort: "low",
    });
    await db.solverJob.create({
      data: { studentId: student.id, mode: "ask", input: question.slice(0, 2000), output: text, model: usage.model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
    });
    return text;
  } catch (err) {
    if (err instanceof LlmRefusalError) return "معلش مش هقدر أجاوب على ده.";
    logger.error({ err }, "ask failed");
    return "حصلت مشكلة مؤقتة، جرب تاني كمان شوية.";
  }
}
