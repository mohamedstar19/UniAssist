import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 });

export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export class LlmRefusalError extends Error {
  constructor(public category: string | null | undefined) {
    super(`Model declined the request (${category ?? "unknown"})`);
  }
}

/**
 * Server-side refusal fallback ("default" routing) is available for the
 * Sonnet 5.5 / Opus 5.x models on the Claude API. Haiku has no server-side fallback.
 */
function fallbackParams(model: string): { betas: string[]; fallbacks?: "default" } {
  if (/^claude-(sonnet-5-5|opus-5)/.test(model)) {
    return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  }
  return { betas: [] };
}

function usageOf(msg: Anthropic.Beta.BetaMessage): LlmUsage {
  const u = msg.usage;
  return {
    model: msg.model,
    tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
  };
}

/** Structured-output call: the response is validated against the zod schema. */
export async function llmJson<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  content: ContentBlock[] | string;
  schema: S;
  maxTokens?: number;
  effort?: Effort;
}): Promise<{ data: z.infer<S>; usage: LlmUsage }> {
  const { betas, fallbacks } = fallbackParams(opts.model);
  const msg = await anthropic.beta.messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.content }],
    output_config: { format: betaZodOutputFormat(opts.schema), effort: opts.effort ?? "low" },
    ...(betas.length ? { betas } : {}),
    ...(fallbacks ? { fallbacks } : {}),
  });
  if (msg.stop_reason === "refusal") throw new LlmRefusalError(msg.stop_details?.category);
  if (msg.parsed_output == null) {
    logger.warn({ stop: msg.stop_reason }, "structured output missing");
    throw new Error(`LLM returned no parseable output (stop_reason=${msg.stop_reason})`);
  }
  return { data: msg.parsed_output as z.infer<S>, usage: usageOf(msg) };
}

/** Free-text call (study assistant). Streams under the hood to avoid HTTP timeouts on long answers. */
export async function llmText(opts: {
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens?: number;
  effort?: Effort;
}): Promise<{ text: string; usage: LlmUsage; truncated: boolean }> {
  const { betas, fallbacks } = fallbackParams(opts.model);
  const stream = anthropic.beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 32000,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: opts.messages,
    output_config: { effort: opts.effort ?? "medium" },
    ...(betas.length ? { betas } : {}),
    ...(fallbacks ? { fallbacks } : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new LlmRefusalError(msg.stop_details?.category);
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text, usage: usageOf(msg), truncated: msg.stop_reason === "max_tokens" };
}

/** Errors worth retrying later (API overloaded, rate limited, network). */
export function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  return err instanceof Anthropic.APIError && (err.status === 529 || err.status === 408);
}

/** Turn a stored file into a content block Claude can read (image / PDF / plain text). */
export function fileBlock(buf: Buffer, mimeType: string, title?: string): ContentBlock | null {
  if (mimeType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
      ...(title ? { title } : {}),
    };
  }
  const img = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  type ImgType = (typeof img)[number];
  if ((img as readonly string[]).includes(mimeType)) {
    return {
      type: "image",
      source: { type: "base64", media_type: mimeType as ImgType, data: buf.toString("base64") },
    };
  }
  if (mimeType.startsWith("text/")) {
    return { type: "text", text: `${title ? `[${title}]\n` : ""}${buf.toString("utf8").slice(0, 200_000)}` };
  }
  return null;
}
