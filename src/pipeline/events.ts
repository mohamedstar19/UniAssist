import { randomBytes } from "node:crypto";
import type { Event, EventStatus, EventType } from "@prisma/client";
import { parseFeatures } from "../features.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { formatDue } from "../lib/time.js";
import { announceEvent, askRepToConfirm, notifyReps, type AnnounceKind } from "../notify/announce.js";
import { esc } from "../notify/format.js";
import { scheduleEventReminders } from "../notify/reminders.js";
import type { ExtractItem } from "./extract.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventPatch {
  type?: EventType;
  courseId?: string | null;
  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  durationMinutes?: number | null;
  status?: EventStatus;
}

export interface MessageSource {
  rawMessageId: string;
  batchId: string;
  senderIsInstructor: boolean;
}

function parseDue(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Applies a patch and records one EventRevision per changed field.
 * Returns the list of fields that actually changed.
 */
export async function applyPatch(eventId: string, patch: EventPatch, fromMessageId?: string): Promise<string[]> {
  const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const changed: string[] = [];
  const data: Record<string, unknown> = {};
  const revisions: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  for (const [field, value] of Object.entries(patch) as [keyof EventPatch, unknown][]) {
    if (value === undefined) continue;
    const old = before[field as keyof Event];
    const same = old instanceof Date && value instanceof Date ? old.getTime() === value.getTime() : old === value;
    if (same) continue;
    changed.push(field);
    data[field] = value;
    revisions.push({ field, oldValue: str(old), newValue: str(value) });
  }
  if (!changed.length) return [];
  await db.$transaction([
    db.event.update({ where: { id: eventId }, data }),
    db.eventRevision.createMany({ data: revisions.map((r) => ({ ...r, eventId, fromMessageId })) }),
  ]);
  return changed;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Same course + same type + due within ±1 day (or both undated) = the same event, re-posted. */
export async function findDuplicate(batchId: string, item: { type: string; courseId: string | null; dueAt: Date | null }): Promise<Event | null> {
  const recent = await db.event.findMany({
    where: {
      batchId,
      type: item.type as EventType,
      courseId: item.courseId,
      status: { in: ["active", "pending"] },
      createdAt: { gte: new Date(Date.now() - 14 * DAY_MS) },
    },
  });
  return (
    recent.find((e) => {
      if (!e.dueAt && !item.dueAt) return true;
      if (!e.dueAt || !item.dueAt) return false;
      return Math.abs(e.dueAt.getTime() - item.dueAt.getTime()) <= DAY_MS;
    }) ?? null
  );
}

/** Applies what the extractor found in one message. */
export async function applyExtraction(items: ExtractItem[], src: MessageSource): Promise<string[]> {
  const batch = await db.batch.findUniqueOrThrow({ where: { id: src.batchId }, include: { courses: true } });
  const features = parseFeatures(batch.features);
  const courseIds = new Set(batch.courses.map((c) => c.id));
  const touched: string[] = [];

  for (const item of items) {
    const courseId = item.courseId && courseIds.has(item.courseId) ? item.courseId : null;
    const dueAt = parseDue(item.dueAt);
    const target = item.targetEventId
      ? await db.event.findFirst({ where: { id: item.targetEventId, batchId: src.batchId } })
      : null;

    if (item.newCourseName && !courseId) {
      await notifyReps(
        src.batchId,
        `📚 فيه مادة اتذكرت ومش موجودة في القايمة: <b>${esc(item.newCourseName)}</b>\nلو مادة جديدة ضيفها بـ:\n<code>/addcourse ${esc(item.newCourseName)}</code>`,
      );
    }

    try {
      if (item.action === "duplicate") {
        if (target) touched.push(target.id);
        continue;
      }

      if ((item.action === "update" || item.action === "cancel") && target) {
        const patch: EventPatch =
          item.action === "cancel"
            ? { status: "cancelled" }
            : {
                ...(dueAt ? { dueAt } : {}),
                ...(item.description && item.description !== target.description ? { description: mergeDescription(target.description, item.description) } : {}),
                ...(item.durationMinutes ? { durationMinutes: item.durationMinutes } : {}),
                ...(item.type !== target.type ? { type: item.type } : {}),
              };
        const summary = item.changeSummary ?? (item.action === "cancel" ? "اتلغى" : "فيه تعديل");

        // A student contradicting an instructor, or a low-confidence change: the rep decides.
        const targetFromInstructor = await createdByInstructor(target);
        if (item.confidence < features.confidenceThreshold || (!src.senderIsInstructor && targetFromInstructor)) {
          await proposeChange(target.id, patch, src.rawMessageId, summary);
          touched.push(target.id);
          continue;
        }
        await commitChange(target.id, patch, src.rawMessageId, summary);
        touched.push(target.id);
        continue;
      }

      if (item.action === "cancel") {
        await notifyReps(src.batchId, `❓ فيه رسالة بتقول إن حاجة اتلغت ومش لاقي هي أنهي حدث:\n<i>${esc(item.changeSummary ?? item.title)}</i>\nلو تعرفها، افتح الحدث من /week وعدّله.`);
        continue;
      }

      // create (or an update whose target we couldn't find: treat as new, the dedupe check still applies)
      const dup = await findDuplicate(src.batchId, { type: item.type, courseId, dueAt });
      if (dup) {
        if (item.description && !dup.description) await applyPatch(dup.id, { description: item.description }, src.rawMessageId);
        touched.push(dup.id);
        continue;
      }

      const needsRep = features.repConfirmAll || item.confidence < features.confidenceThreshold || item.needsDate;
      const event = await db.event.create({
        data: {
          batchId: src.batchId,
          courseId,
          type: item.type,
          title: item.title.slice(0, 200),
          description: item.description || null,
          dueAt,
          durationMinutes: item.durationMinutes,
          createdFromMessageId: src.rawMessageId,
          status: needsRep ? "pending" : "active",
          confidence: item.confidence,
        },
      });
      touched.push(event.id);
      if (needsRep) {
        const reason = item.needsDate
          ? "الميعاد مش واضح من الرسالة (مثلاً \"المحاضرة الجاية\"). ابعتلي الميعاد الصح بـ✏️ تعديل."
          : item.confidence < features.confidenceThreshold
            ? `مش متأكد إن ده حدث حقيقي (ثقة ${Math.round(item.confidence * 100)}%).`
            : "وضع المراجعة شغال: كل حاجة بتعدي عليك الأول.";
        await askRepToConfirm(event.id, reason);
      } else {
        await announceEvent(event.id, "new");
      }
    } catch (err) {
      logger.error({ err, item }, "failed to apply extracted item");
      throw err;
    }
  }
  return touched;
}

function mergeDescription(old: string | null, add: string): string {
  if (!old) return add;
  if (old.includes(add)) return old;
  return `${old}\n\n${add}`;
}

async function createdByInstructor(e: Event): Promise<boolean> {
  if (!e.createdFromMessageId) return false;
  const msg = await db.rawMessage.findUnique({ where: { id: e.createdFromMessageId } });
  if (!msg?.senderHint || !e.courseId) return false;
  return isInstructor(e.batchId, msg.senderHint);
}

export async function isInstructor(batchId: string, senderHint: string): Promise<boolean> {
  const digits = senderHint.replace(/\D/g, "");
  const tail = digits.slice(-10);
  const instructors = await db.instructor.findMany({ where: { course: { batchId }, phoneHint: { not: null } } });
  return instructors.some((i) => {
    const h = i.phoneHint!.replace(/\D/g, "");
    return h === senderHint || (tail.length >= 8 && h.endsWith(tail));
  });
}

/** Apply a change and tell everyone (if the event is live). */
export async function commitChange(eventId: string, patch: EventPatch, fromMessageId: string | undefined, summary: string): Promise<void> {
  const changed = await applyPatch(eventId, patch, fromMessageId);
  if (!changed.length) return;
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  if (event.status === "pending") {
    await askRepToConfirm(eventId, `اتعدل قبل التأكيد: ${summary}`);
    return;
  }
  if (event.status === "cancelled" || event.status === "rejected") {
    await scheduleEventReminders(eventId); // clears pending reminders
    if (changed.includes("status") && event.status === "cancelled" && event.notifiedAt) await announceEvent(eventId, "cancelled", summary);
    return;
  }
  const kind: AnnounceKind = event.notifiedAt ? "changed" : "new";
  await announceEvent(eventId, kind, kind === "changed" ? summary : null);
}

// ---- Proposed changes waiting for the rep -------------------------------------------------

interface StoredChange {
  eventId: string;
  patch: Record<string, unknown>;
  fromMessageId?: string;
  summary: string;
}

export async function proposeChange(eventId: string, patch: EventPatch, fromMessageId: string | undefined, summary: string): Promise<void> {
  const id = randomBytes(6).toString("hex");
  const stored: StoredChange = { eventId, patch: { ...patch, dueAt: patch.dueAt?.toISOString() ?? patch.dueAt }, fromMessageId, summary };
  await redis.set(`chg:${id}`, JSON.stringify(stored), "EX", 14 * 24 * 3600);
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { course: true, batch: true } });
  const msg = fromMessageId ? await db.rawMessage.findUnique({ where: { id: fromMessageId } }) : null;
  const lines = [
    "⚖️ <b>تعديل محتاج تأكيدك</b>",
    `${esc(event.title)}${event.course ? ` · ${esc(event.course.name)}` : ""}`,
    `الميعاد الحالي: ${formatDue(event.dueAt, event.batch.timezone)}`,
    `التعديل المقترح: ${esc(summary)}`,
  ];
  if (patch.dueAt) lines.push(`الميعاد الجديد: ${formatDue(patch.dueAt, event.batch.timezone)}`);
  if (msg?.text) lines.push("", `💬 ${msg.senderName ? `${esc(msg.senderName)}: ` : ""}<i>${esc(msg.text.slice(0, 500))}</i>`);
  await notifyReps(event.batchId, lines.join("\n"), [
    [
      { text: "✅ طبّق التعديل", data: `chg:ok:${id}` },
      { text: "❌ تجاهل", data: `chg:no:${id}` },
    ],
  ]);
}

export async function resolveProposedChange(id: string, accept: boolean): Promise<string> {
  const raw = await redis.getdel(`chg:${id}`);
  if (!raw) return "التعديل ده اتحسم قبل كده أو انتهت صلاحيته.";
  if (!accept) return "تمام، اتجاهل.";
  const c = JSON.parse(raw) as StoredChange;
  const patch: EventPatch = { ...(c.patch as EventPatch) };
  if (typeof c.patch.dueAt === "string") patch.dueAt = new Date(c.patch.dueAt);
  await commitChange(c.eventId, patch, c.fromMessageId, c.summary);
  return "✅ اتطبق واتبعت للدفعة.";
}

/** Rep confirmed a pending event. */
export async function confirmEvent(eventId: string): Promise<Event | null> {
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event || event.status !== "pending") return event;
  await applyPatch(eventId, { status: "active" });
  await announceEvent(eventId, "new");
  return db.event.findUnique({ where: { id: eventId } });
}
