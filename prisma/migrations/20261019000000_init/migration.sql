-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('whatsapp', 'telegram');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('batch', 'section', 'course');

-- CreateEnum
CREATE TYPE "InstructorRole" AS ENUM ('doctor', 'ta');

-- CreateEnum
CREATE TYPE "StudentRole" AS ENUM ('student', 'rep');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('assignment', 'quiz', 'exam', 'schedule_change', 'announcement');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('pending', 'active', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "MessageClass" AS ENUM ('assignment', 'quiz', 'exam', 'schedule_change', 'announcement', 'material', 'noise');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('image', 'pdf', 'document', 'other');

-- CreateEnum
CREATE TYPE "MaterialType" AS ENUM ('slides', 'sheet', 'assignment', 'model_answer', 'past_exam', 'other');

-- CreateEnum
CREATE TYPE "SolverMode" AS ENUM ('explain', 'hint', 'solve', 'review', 'quiz', 'pastexam', 'plan', 'ask');

-- CreateTable
CREATE TABLE "Faculty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "university" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Faculty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "facultyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "webToken" TEXT NOT NULL,
    "channelId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "source" "Source" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT,
    "type" "GroupType" NOT NULL DEFAULT 'batch',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instructor" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "InstructorRole" NOT NULL DEFAULT 'doctor',
    "phoneHint" TEXT,

    CONSTRAINT "Instructor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LectureSlot" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,

    CONSTRAINT "LectureSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT NOT NULL,
    "role" "StudentRole" NOT NULL DEFAULT 'student',
    "reminderPrefs" JSONB NOT NULL DEFAULT '{}',
    "mutedCourseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acceptedTermsAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "senderHint" TEXT,
    "senderName" TEXT,
    "text" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "replyToExternalId" TEXT,
    "replyToId" TEXT,
    "classification" "MessageClass",
    "classConfidence" DOUBLE PRECISION,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Media" (
    "id" TEXT NOT NULL,
    "rawMessageId" TEXT,
    "batchId" TEXT NOT NULL,
    "courseId" TEXT,
    "kind" "MediaKind" NOT NULL,
    "materialType" "MaterialType" NOT NULL DEFAULT 'other',
    "lectureNumber" INTEGER,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "extractedText" TEXT,
    "title" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialChunk" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "courseId" TEXT,
    "idx" INTEGER NOT NULL,
    "page" INTEGER,
    "content" TEXT NOT NULL,

    CONSTRAINT "MaterialChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "courseId" TEXT,
    "type" "EventType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "createdFromMessageId" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRevision" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "fromMessageId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Correction" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "sentAt" TIMESTAMP(3),
    "cancelled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolverJob" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "studentId" TEXT NOT NULL,
    "mode" "SolverMode" NOT NULL,
    "input" TEXT,
    "inputFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "output" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "blocked" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolverJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySession" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Batch_inviteCode_key" ON "Batch"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_webToken_key" ON "Batch"("webToken");

-- CreateIndex
CREATE UNIQUE INDEX "Group_source_externalId_key" ON "Group"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Course_batchId_name_key" ON "Course"("batchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Student_telegramId_key" ON "Student"("telegramId");

-- CreateIndex
CREATE INDEX "RawMessage_processedAt_idx" ON "RawMessage"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawMessage_groupId_externalId_key" ON "RawMessage"("groupId", "externalId");

-- CreateIndex
CREATE INDEX "Media_batchId_courseId_idx" ON "Media"("batchId", "courseId");

-- CreateIndex
CREATE INDEX "MaterialChunk_batchId_courseId_idx" ON "MaterialChunk"("batchId", "courseId");

-- CreateIndex
CREATE INDEX "Event_batchId_status_dueAt_idx" ON "Event"("batchId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Reminder_fireAt_sentAt_cancelled_idx" ON "Reminder"("fireAt", "sentAt", "cancelled");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_eventId_studentId_fireAt_key" ON "Reminder"("eventId", "studentId", "fireAt");

-- CreateIndex
CREATE INDEX "SolverJob_studentId_createdAt_idx" ON "SolverJob"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "StudySession_studentId_finished_idx" ON "StudySession"("studentId", "finished");

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "Faculty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instructor" ADD CONSTRAINT "Instructor_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureSlot" ADD CONSTRAINT "LectureSlot_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureSlot" ADD CONSTRAINT "LectureSlot_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawMessage" ADD CONSTRAINT "RawMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawMessage" ADD CONSTRAINT "RawMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "RawMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_rawMessageId_fkey" FOREIGN KEY ("rawMessageId") REFERENCES "RawMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_createdFromMessageId_fkey" FOREIGN KEY ("createdFromMessageId") REFERENCES "RawMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRevision" ADD CONSTRAINT "EventRevision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRevision" ADD CONSTRAINT "EventRevision_fromMessageId_fkey" FOREIGN KEY ("fromMessageId") REFERENCES "RawMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolverJob" ADD CONSTRAINT "SolverJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolverJob" ADD CONSTRAINT "SolverJob_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Full-text search over course material for the study assistant.
-- 'simple' config: works for mixed Arabic/English text without stemming.
CREATE INDEX "MaterialChunk_content_fts" ON "MaterialChunk" USING GIN (to_tsvector('simple', "content"));
