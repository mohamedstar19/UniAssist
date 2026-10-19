import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prompts live in /prompts (outside the code) so they can be tuned without touching logic.
const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = process.env.PROMPTS_DIR ?? path.resolve(here, "../../prompts");

const cache = new Map<string, string>();

export function prompt(name: "classify" | "extract" | "material" | "tutor" | "correction" | "ask"): string {
  let p = cache.get(name);
  if (!p) {
    p = readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
    cache.set(name, p);
  }
  return p;
}
