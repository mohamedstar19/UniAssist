import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { announceMaterial } from "../notify/material.js";
import { classifyMessage } from "./classify.js";
import { batchCourses } from "./courses.js";
import { applyExtraction, isInstructor } from "./events.js";
import { extractEvents } from "./extract.js";
import { processMessageMedia } from "./media.js";
import { shouldClassify } from "./prefilter.js";

/**
 * One raw message through the pipeline:
 * files → cheap filter → classify (fast model) → extract (smart model) → apply to the agenda.
 */
export async function processRawMessage(rawMessageId: string): Promise<void> {
  const msg = await db.rawMessage.findUnique({
    where: { id: rawMessageId },
    include: { group: { include: { batch: true } }, media: true, replyTo: { include: { createdEvents: true, media: true } } },
  });
  if (!msg || msg.processedAt || !msg.group.batch) return;
  const batch = msg.group.batch;
  const text = msg.text ?? "";
  const senderIsInstructor = msg.senderHint ? await isInstructor(batch.id, msg.senderHint) : false;
  const replyEvents = msg.replyTo?.createdEvents ?? [];
  const replyRevisions = msg.replyToId ? await db.eventRevision.count({ where: { fromMessageId: msg.replyToId } }) : 0;

  const pass = shouldClassify({
    text,
    hasMedia: msg.media.length > 0,
    isReplyToTrackedMessage: replyEvents.length > 0 || replyRevisions > 0,
    senderIsInstructor,
  });
  if (!pass) {
    await db.rawMessage.update({ where: { id: msg.id }, data: { classification: "noise", classConfidence: 1, processedAt: new Date() } });
    return;
  }

  const files = await processMessageMedia(msg.id, text);
  const fileTexts = files.map((f) => f.text).filter(Boolean);

  const cls = await classifyMessage({ text, fileTexts, senderIsInstructor, replyToText: msg.replyTo?.text });
  logger.info({ rawMessageId, type: cls.type, confidence: cls.confidence }, "classified");

  if (cls.type === "noise" || cls.type === "material") {
    await db.rawMessage.update({
      where: { id: msg.id },
      data: { classification: cls.type, classConfidence: cls.confidence, processedAt: new Date() },
    });
    if (cls.type === "material" && files.length) await announceMaterial(batch.id, files.map((f) => f.media.id));
    return;
  }

  const [courses, openEvents, lectureSlots] = await Promise.all([
    batchCourses(batch.id),
    db.event.findMany({
      where: {
        batchId: batch.id,
        status: { in: ["active", "pending"] },
        OR: [{ dueAt: { gte: new Date(msg.sentAt.getTime() - 14 * 86400_000) } }, { dueAt: null, createdAt: { gte: new Date(Date.now() - 14 * 86400_000) } }],
      },
      include: { course: true },
      orderBy: { dueAt: "asc" },
      take: 60,
    }),
    db.lectureSlot.findMany({ where: { batchId: batch.id }, include: { course: true } }),
  ]);
  const instructor = senderIsInstructor && msg.senderHint
    ? await db.instructor.findFirst({ where: { course: { batchId: batch.id }, phoneHint: { contains: msg.senderHint.replace(/\D/g, "").slice(-8) } } })
    : null;

  const { data } = await extractEvents({
    tz: batch.timezone,
    courses,
    openEvents,
    lectureSlots,
    message: { text, sentAt: msg.sentAt, senderName: msg.senderName, senderIsInstructor, instructorName: instructor?.name },
    fileTexts: files.filter((f) => f.text).map((f) => ({ name: f.media.filename ?? f.media.title ?? "file", text: f.text })),
    replyTo: msg.replyTo ? { text: msg.replyTo.text, eventIds: replyEvents.map((e) => e.id) } : null,
    messageClass: cls.type,
  });

  const touched = await applyExtraction(data.items, { rawMessageId: msg.id, batchId: batch.id, senderIsInstructor });

  // Files attached to an assignment message get the event's course, so they show up in the library.
  const unfiled = files.filter((f) => !f.media.courseId).map((f) => f.media.id);
  if (unfiled.length && touched.length) {
    const withCourse = await db.event.findFirst({ where: { id: { in: touched }, courseId: { not: null } } });
    if (withCourse) {
      await db.media.updateMany({ where: { id: { in: unfiled } }, data: { courseId: withCourse.courseId } });
      await db.materialChunk.updateMany({ where: { mediaId: { in: unfiled } }, data: { courseId: withCourse.courseId } });
    }
  }

  await db.rawMessage.update({
    where: { id: msg.id },
    data: { classification: cls.type, classConfidence: cls.confidence, processedAt: new Date() },
  });
}
