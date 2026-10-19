import type { Course } from "@prisma/client";
import { db } from "../lib/db.js";
import { normalizeArabic } from "./prefilter.js";

function norm(s: string): string {
  return normalizeArabic(s).replace(/[\s\-_.]+/g, "");
}

/** Deterministic alias match, used for commands like "/course Networks". */
export function matchCourseByName(courses: Course[], query: string): Course | null {
  const q = norm(query);
  if (!q) return null;
  for (const c of courses) {
    const names = [c.name, c.code ?? "", ...c.aliases].map(norm).filter(Boolean);
    if (names.includes(q)) return c;
  }
  for (const c of courses) {
    const names = [c.name, c.code ?? "", ...c.aliases].map(norm).filter((n) => n.length >= 3);
    if (names.some((n) => n.includes(q) || q.includes(n))) return c;
  }
  return null;
}

export async function batchCourses(batchId: string): Promise<Course[]> {
  return db.course.findMany({ where: { batchId }, orderBy: { name: "asc" } });
}

/** Compact course list for prompts. */
export function coursesForPrompt(courses: Course[]): string {
  if (!courses.length) return "(no courses registered yet)";
  return courses
    .map((c) => `- id=${c.id} | ${c.name}${c.code ? ` | code ${c.code}` : ""}${c.aliases.length ? ` | aliases: ${c.aliases.join(", ")}` : ""}`)
    .join("\n");
}
