import { randomBytes } from "node:crypto";
import { db } from "../lib/db.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newInviteCode(len = 6): string {
  return Array.from(randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Creates a batch (and its faculty if new). Used by the bot (/newbatch) and the admin page. */
export async function createBatch(input: { university: string; facultyName: string; name: string; year?: number }) {
  const faculty =
    (await db.faculty.findFirst({ where: { university: input.university, name: input.facultyName } })) ??
    (await db.faculty.create({ data: { university: input.university, name: input.facultyName } }));
  return db.batch.create({
    data: {
      facultyId: faculty.id,
      name: input.name,
      year: input.year && input.year > 2000 ? input.year : new Date().getFullYear(),
      inviteCode: newInviteCode(6),
      webToken: randomBytes(12).toString("base64url"),
    },
  });
}

export function splitAliases(s?: string | null): string[] {
  return [...new Set((s ?? "").split(/[,،\n]/).map((x) => x.trim()).filter(Boolean))];
}
