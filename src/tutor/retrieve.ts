import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { materialLabel } from "../notify/material.js";

export interface Snippet {
  id: string;
  content: string;
  page: number | null;
  title: string | null;
  materialType: string;
  lectureNumber: number | null;
  course: string | null;
}

const STOP = new Set([
  "the", "and", "for", "with", "what", "how", "why", "this", "that", "is", "are", "of", "in", "on", "to", "a", "an",
  "في", "من", "على", "عن", "ايه", "إيه", "اية", "ازاي", "إزاي", "ليه", "هو", "هي", "ده", "دي", "دا", "اللي", "يعني",
  "مش", "انا", "أنا", "عايز", "عاوز", "ممكن", "لو", "او", "أو", "مع", "كده", "بتاع", "بتاعة", "الى", "إلى", "ما",
]);

/** Builds an OR tsquery from free text (Arabic/English), with prefix matching on longer words. */
export function buildTsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .slice(0, 16);
  const uniq = [...new Set(tokens)];
  if (!uniq.length) return null;
  return uniq.map((t) => (t.length >= 4 ? `${t}:*` : t)).join(" | ");
}

/** Full-text search over the batch's course material. */
export async function searchMaterial(batchId: string, courseId: string | null, query: string, limit = 8): Promise<Snippet[]> {
  const tsq = buildTsQuery(query);
  if (!tsq) return [];
  return db.$queryRaw<Snippet[]>(Prisma.sql`
    SELECT c.id, c.content, c.page, m.title, m."materialType"::text AS "materialType", m."lectureNumber", co.name AS course
    FROM "MaterialChunk" c
    JOIN "Media" m ON m.id = c."mediaId"
    LEFT JOIN "Course" co ON co.id = c."courseId"
    WHERE c."batchId" = ${batchId}
      AND (${courseId}::text IS NULL OR c."courseId" = ${courseId})
      AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${tsq})
    ORDER BY ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${tsq})) DESC
    LIMIT ${limit}
  `);
}

/** Material of one lecture (or the latest material of the course), for quizzes and summaries. */
export async function lectureMaterial(batchId: string, courseId: string, lectureNumber: number | null, maxChars = 40_000): Promise<Snippet[]> {
  const chunks = await db.materialChunk.findMany({
    where: {
      batchId,
      courseId,
      media: lectureNumber ? { lectureNumber } : { materialType: { in: ["slides", "sheet", "model_answer", "past_exam"] } },
    },
    include: { media: { include: { course: true } } },
    orderBy: [{ media: { createdAt: "desc" } }, { idx: "asc" }],
    take: 200,
  });
  const out: Snippet[] = [];
  let total = 0;
  for (const c of chunks) {
    if (total + c.content.length > maxChars) break;
    total += c.content.length;
    out.push({
      id: c.id,
      content: c.content,
      page: c.page,
      title: c.media.title,
      materialType: c.media.materialType,
      lectureNumber: c.media.lectureNumber,
      course: c.media.course?.name ?? null,
    });
  }
  return out;
}

export function snippetsForPrompt(snippets: Snippet[]): string {
  if (!snippets.length) return "";
  return snippets
    .map((s) => {
      const tag = [s.course, s.lectureNumber ? `Lecture ${s.lectureNumber}` : materialLabel(s.materialType), s.page ? `p.${s.page}` : null]
        .filter(Boolean)
        .join(" · ");
      return `[${tag}${s.title ? ` · ${s.title}` : ""}]\n${s.content}`;
    })
    .join("\n\n---\n\n");
}
