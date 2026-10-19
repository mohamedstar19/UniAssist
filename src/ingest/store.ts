import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { putFile } from "../lib/storage.js";
import { enqueueMessage } from "../queues.js";
import type { NormalizedMessage } from "../types.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function mediaKind(mime: string): "image" | "pdf" | "document" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("application/") || mime.startsWith("text/")) return "document";
  return "other";
}

/**
 * Common entry point for every source. Stores the raw message (+ files) and
 * queues it for classification. Messages from groups that aren't linked to a
 * batch are not stored: the group is only recorded so the admin can link it.
 */
export async function ingestMessage(msg: NormalizedMessage): Promise<void> {
  const group = await db.group.upsert({
    where: { source_externalId: { source: msg.source, externalId: msg.groupExternalId } },
    create: { source: msg.source, externalId: msg.groupExternalId, title: msg.groupTitle },
    update: msg.groupTitle ? { title: msg.groupTitle } : {},
  });
  if (!group.batchId) return;

  const replyTo = msg.replyToExternalId
    ? await db.rawMessage.findUnique({
        where: { groupId_externalId: { groupId: group.id, externalId: msg.replyToExternalId } },
        select: { id: true },
      })
    : null;

  let raw;
  try {
    raw = await db.rawMessage.create({
      data: {
        groupId: group.id,
        externalId: msg.externalId,
        senderHint: msg.sender,
        senderName: msg.senderName,
        text: msg.text || null,
        sentAt: msg.sentAt,
        replyToExternalId: msg.replyToExternalId,
        replyToId: replyTo?.id,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return; // duplicate delivery
    throw err;
  }

  for (const m of msg.media) {
    try {
      if (m.sizeBytes && m.sizeBytes > MAX_FILE_BYTES) {
        logger.warn({ size: m.sizeBytes, file: m.filename }, "file too large, skipped");
        continue;
      }
      const data = await m.download();
      if (data.length > MAX_FILE_BYTES) continue;
      const key = `${group.batchId}/${raw.id}/${randomUUID()}${extOf(m.filename, m.mimeType)}`;
      await putFile(key, data, m.mimeType);
      await db.media.create({
        data: {
          rawMessageId: raw.id,
          batchId: group.batchId,
          kind: mediaKind(m.mimeType),
          mimeType: m.mimeType,
          storageKey: key,
          filename: m.filename,
          sizeBytes: data.length,
        },
      });
    } catch (err) {
      logger.error({ err, rawMessageId: raw.id }, "media download failed");
    }
  }

  await enqueueMessage(raw.id);
}

function extOf(filename: string | undefined, mime: string): string {
  const fromName = filename?.match(/\.[a-z0-9]{1,6}$/i)?.[0];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return map[mime] ?? "";
}
