import type { Course, Event, LectureSlot } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { llmJson } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";
import { promptDate } from "../lib/time.js";
import { coursesForPrompt } from "./courses.js";

export const ExtractItemSchema = z.object({
  action: z.enum(["create", "update", "cancel", "duplicate"]),
  targetEventId: z.string().nullable(),
  type: z.enum(["assignment", "quiz", "exam", "announcement"]),
  courseId: z.string().nullable(),
  newCourseName: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  dueAt: z.string().nullable(),
  needsDate: z.boolean(),
  durationMinutes: z.number().int().nullable(),
  changeSummary: z.string().nullable(),
  confidence: z.number(),
});
export type ExtractItem = z.infer<typeof ExtractItemSchema>;

const ExtractSchema = z.object({ items: z.array(ExtractItemSchema) });

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface ExtractContext {
  tz: string;
  courses: Course[];
  openEvents: (Event & { course: Course | null })[];
  lectureSlots: (LectureSlot & { course: Course })[];
  message: { text: string; sentAt: Date; senderName?: string | null; senderIsInstructor: boolean; instructorName?: string };
  fileTexts: { name: string; text: string }[];
  replyTo?: { text: string | null; eventIds: string[] } | null;
  messageClass: string;
}

function eventsForPrompt(events: ExtractContext["openEvents"], tz: string): string {
  if (!events.length) return "(none)";
  return events
    .map(
      (e) =>
        `- id=${e.id} | ${e.type} | course: ${e.course?.name ?? "?"} | "${e.title}" | due: ${e.dueAt ? promptDate(e.dueAt, tz) : "unknown"} | status: ${e.status}` +
        (e.description ? ` | details: ${e.description.slice(0, 200).replace(/\n/g, " ")}` : ""),
    )
    .join("\n");
}

export async function extractEvents(ctx: ExtractContext) {
  const slots = ctx.lectureSlots.length
    ? ctx.lectureSlots.map((s) => `- ${s.course.name}: ${WEEKDAYS[s.weekday]} ${s.startTime}`).join("\n")
    : "(not provided)";
  const sender = ctx.message.senderIsInstructor
    ? `${ctx.message.instructorName ?? ctx.message.senderName ?? "?"} (known doctor/TA)`
    : `${ctx.message.senderName ?? "unknown"} (student / unknown member)`;

  const content = [
    `## Courses\n${coursesForPrompt(ctx.courses)}`,
    `## Open events\n${eventsForPrompt(ctx.openEvents, ctx.tz)}`,
    `## Weekly lecture schedule\n${slots}`,
    ctx.replyTo
      ? `## The message replies to\n"""${(ctx.replyTo.text ?? "(file only)").slice(0, 1500)}"""\nEvents created from that message: ${ctx.replyTo.eventIds.join(", ") || "none"}`
      : null,
    `## Message\nSent: ${promptDate(ctx.message.sentAt, ctx.tz)}\nSender: ${sender}\nPre-classified as: ${ctx.messageClass}\n"""${ctx.message.text || "(no text)"}"""`,
    ...ctx.fileTexts.map((f) => `## Attached file: ${f.name}\n"""${f.text.slice(0, 15000)}"""`),
  ]
    .filter(Boolean)
    .join("\n\n");

  return llmJson({
    model: config.MODEL_SMART,
    system: prompt("extract"),
    content,
    schema: ExtractSchema,
    maxTokens: 16000,
    effort: "medium",
  });
}
