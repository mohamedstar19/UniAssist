import { z } from "zod";
import { config } from "../config.js";
import { llmJson } from "../llm/client.js";
import { db } from "../lib/db.js";
import { gate, type StudentWithBatch } from "./tutor.js";
import { lectureMaterial, searchMaterial, snippetsForPrompt } from "./retrieve.js";

const QuizSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()),
      correctIndex: z.number().int(),
      explanation: z.string(),
      source: z.string(),
    }),
  ),
});
export type QuizQuestion = z.infer<typeof QuizSchema>["questions"][number];

export interface QuizState {
  courseName: string;
  questions: QuizQuestion[];
  answers: number[];
  current: number;
}

const QUIZ_SYSTEM = `You write practice multiple-choice quizzes for Egyptian university students, strictly from the course material provided.
- Write questions in the language of the material (usually English); add short Egyptian Arabic in explanations.
- Exactly 4 options per question, one correct; plausible distractors based on common mistakes.
- Mix recall, understanding and small calculations/problems if the material has them.
- "explanation": 1–3 sentences on why the answer is right (and why the tempting wrong option is wrong).
- "source": where in the material it comes from, e.g. "Lecture 4 p.12".
- Never test something that is not in the material.`;

export type StartQuizResult = { ok: true; sessionId: string; state: QuizState } | { ok: false; reason: string };

/** Builds a 5-question practice quiz from a lecture, an upcoming quiz/exam, or a topic. */
export async function startQuiz(
  student: StudentWithBatch,
  opts: { courseId: string; lectureNumber?: number | null; eventId?: string | null; topic?: string | null; count?: number },
): Promise<StartQuizResult> {
  const blocked = await gate(student, "quiz");
  if (blocked) return { ok: false, reason: blocked };
  const course = await db.course.findFirst({ where: { id: opts.courseId, batchId: student.batchId } });
  if (!course) return { ok: false, reason: "مش لاقي المادة دي." };

  const event = opts.eventId ? await db.event.findUnique({ where: { id: opts.eventId } }) : null;
  const topic = [opts.topic, event?.title, event?.description].filter(Boolean).join(" ");
  let snippets = topic ? await searchMaterial(student.batchId, course.id, topic, 12) : [];
  if (snippets.length < 3) snippets = await lectureMaterial(student.batchId, course.id, opts.lectureNumber ?? null, 30_000);
  if (!snippets.length) {
    return { ok: false, reason: `لسه مفيش سلايدات أو ملفات لمادة ${course.name} في المكتبة. أول ما تتبعت في الجروب هقدر أمتحنك فيها.` };
  }

  const count = opts.count ?? 5;
  const { data, usage } = await llmJson({
    model: config.MODEL_SMART,
    system: QUIZ_SYSTEM,
    schema: QuizSchema,
    content:
      `Course: ${course.name}\n${event ? `Upcoming: ${event.title}\n${event.description ?? ""}\n` : ""}${opts.topic ? `Focus: ${opts.topic}\n` : ""}` +
      `Write ${count} questions.\n\n## Material\n${snippetsForPrompt(snippets)}`,
    maxTokens: 16000,
    effort: "medium",
  });
  const questions = data.questions
    .filter((q) => q.options.length >= 2 && q.correctIndex >= 0 && q.correctIndex < q.options.length)
    .slice(0, count);
  if (!questions.length) return { ok: false, reason: "معرفتش أطلع أسئلة كويسة من الملفات دي، جرب محاضرة تانية." };

  const state: QuizState = { courseName: course.name, questions, answers: [], current: 0 };
  const session = await db.studySession.create({ data: { studentId: student.id, kind: "quiz", state: state as object } });
  await db.solverJob.create({
    data: { studentId: student.id, eventId: event?.id, mode: "quiz", input: topic.slice(0, 2000), output: JSON.stringify(questions).slice(0, 20000), model: usage.model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
  });
  return { ok: true, sessionId: session.id, state };
}

/** Records an answer. Returns the updated state and whether it was correct. */
export async function answerQuiz(studentId: string, sessionId: string, questionIndex: number, choice: number) {
  const session = await db.studySession.findFirst({ where: { id: sessionId, studentId } });
  if (!session || session.finished) return null;
  const state = session.state as unknown as QuizState;
  if (questionIndex !== state.current) return null; // double tap / old message
  const q = state.questions[questionIndex];
  if (!q) return null;
  state.answers[questionIndex] = choice;
  state.current += 1;
  const finished = state.current >= state.questions.length;
  await db.studySession.update({ where: { id: sessionId }, data: { state: state as object, finished } });
  return { state, correct: choice === q.correctIndex, question: q, finished };
}

export function quizScore(state: QuizState): number {
  return state.questions.reduce((n, q, i) => n + (state.answers[i] === q.correctIndex ? 1 : 0), 0);
}
