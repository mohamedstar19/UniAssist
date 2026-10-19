import { z } from "zod";
import { config } from "../config.js";
import { llmJson, type LlmUsage } from "../llm/client.js";
import { prompt } from "../llm/prompts.js";

export const MessageClassSchema = z.enum(["assignment", "quiz", "exam", "schedule_change", "announcement", "material", "noise"]);
export type MessageClassName = z.infer<typeof MessageClassSchema>;

const ClassifySchema = z.object({
  type: MessageClassSchema,
  confidence: z.number(),
});

export interface ClassifyInput {
  text: string;
  fileTexts: string[];
  senderIsInstructor: boolean;
  replyToText?: string | null;
}

export async function classifyMessage(input: ClassifyInput): Promise<{ type: MessageClassName; confidence: number; usage: LlmUsage }> {
  const parts = [
    `Sender: ${input.senderIsInstructor ? "a known doctor/TA of the course" : "a member of the group (student or unknown)"}`,
    input.replyToText ? `It replies to: """${input.replyToText.slice(0, 1000)}"""` : null,
    `Message: """${input.text || "(no text)"}"""`,
    ...input.fileTexts.map((t, i) => `Attached file ${i + 1} (text, truncated): """${t.slice(0, 3000)}"""`),
  ].filter(Boolean);
  const { data, usage } = await llmJson({
    model: config.MODEL_FAST,
    system: prompt("classify"),
    content: parts.join("\n\n"),
    schema: ClassifySchema,
    maxTokens: 4000,
    effort: "low",
  });
  return { type: data.type, confidence: Math.max(0, Math.min(1, data.confidence)), usage };
}
