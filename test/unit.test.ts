import { describe, expect, it } from "vitest";
import { parseFeatures } from "../src/features.js";
import { fmtOffset, parseOffsets } from "../src/bot/student.js";
import { mdToTelegramHtml, splitMarkdown } from "../src/notify/format.js";
import { reminderTimes } from "../src/notify/reminders.js";
import { isPastDue, relativeFromNow } from "../src/lib/time.js";
import { similarTitles } from "../src/pipeline/events.js";
import { checkUploads } from "../src/tutor/tutor.js";
import { chunkText } from "../src/pipeline/media.js";
import { shouldClassify } from "../src/pipeline/prefilter.js";
import { lockWindow } from "../src/tutor/guard.js";
import { buildTsQuery } from "../src/tutor/retrieve.js";
import { buildIcs } from "../src/web/ics.js";

const base = { hasMedia: false, isReplyToTrackedMessage: false, senderIsInstructor: false };

describe("prefilter", () => {
  it("drops chatter", () => {
    for (const text of ["تمام", "ههههههه", "صباح الخير يا جماعة", "شكرا ليك يا باشا", "مين جاي الكافيتريا يا شباب"]) {
      expect(shouldClassify({ ...base, text })).toBe(false);
    }
  });

  it("keeps study messages", () => {
    for (const text of [
      "الكويز اللي كان الأحد بقى التلات",
      "Assignment 2 deadline is Thursday 11:59pm",
      "التسليم بعد أسبوع",
      "الدكتور بيقول الميد هيبقى 12/11",
      "سلايدات lecture 5 اهي",
      "إمتحان الفيزياء اتأجل",
    ]) {
      expect(shouldClassify({ ...base, text })).toBe(true);
    }
  });

  it("always keeps files and replies to tracked messages", () => {
    expect(shouldClassify({ ...base, text: "", hasMedia: true })).toBe(true);
    expect(shouldClassify({ ...base, text: "ده اتلغى", isReplyToTrackedMessage: true })).toBe(true);
  });
});

describe("reminders", () => {
  it("plans 3d/1d/3h before and skips times already passed", () => {
    const now = new Date("2026-10-19T10:00:00Z");
    const due = new Date("2026-10-21T12:00:00Z"); // ~2 days ahead
    const times = reminderTimes(due, [4320, 1440, 180], now);
    expect(times.map((t) => t.toISOString())).toEqual(["2026-10-20T12:00:00.000Z", "2026-10-21T09:00:00.000Z"]);
  });

  it("anchors day-only quizzes at 8 AM and keeps quiet hours", () => {
    const now = new Date("2026-10-19T10:00:00Z");
    const dayOnly = new Date("2026-10-24T21:00:00Z"); // Sunday 25 Oct, 00:00 Cairo (UTC+3)
    const times = reminderTimes(dayOnly, [4320, 1440, 180], now, "Africa/Cairo").map((t) => t.toISOString());
    // 3d → Thu 08:00, 1d → Sat 08:00, 3h before 08:00 = 05:00 → moved to Sat 22:00 (all Cairo time)
    expect(times).toEqual(["2026-10-22T05:00:00.000Z", "2026-10-24T05:00:00.000Z", "2026-10-24T19:00:00.000Z"]);
  });

  it("treats a day-only event as upcoming for the whole day", () => {
    const dayOnly = new Date("2026-10-24T21:00:00Z"); // 25 Oct 00:00 Cairo
    expect(isPastDue(dayOnly, "Africa/Cairo", new Date("2026-10-25T12:00:00Z"))).toBe(false);
    expect(isPastDue(dayOnly, "Africa/Cairo", new Date("2026-10-25T21:30:00Z"))).toBe(true);
    expect(relativeFromNow(dayOnly, new Date("2026-10-24T09:00:00Z"), "Africa/Cairo")).toBe("بكرة");
  });

  it("parses /remind arguments", () => {
    expect(parseOffsets("3d 1d 3h")).toEqual([4320, 1440, 180]);
    expect(parseOffsets("30m")).toEqual([30]);
    expect(parseOffsets("2 يوم")).toBeNull();
    expect(parseOffsets("2يوم 5ساعة")).toEqual([2880, 300]);
    expect(parseOffsets("abc")).toBeNull();
    expect(fmtOffset(1440)).toBe("1 يوم");
  });
});

describe("exam lock", () => {
  const f = parseFeatures({});
  it("locks from 30 min before a quiz until it ends", () => {
    const due = new Date("2026-10-22T11:00:00Z");
    const w = lockWindow({ type: "quiz", dueAt: due, durationMinutes: null }, f, "Africa/Cairo")!;
    expect(w.from.toISOString()).toBe("2026-10-22T10:30:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-22T12:00:00.000Z");
  });

  it("locks the whole day when only the date is known", () => {
    // 00:00 Cairo time (UTC+3 in October 2026)
    const due = new Date("2026-10-21T21:00:00Z");
    const w = lockWindow({ type: "exam", dueAt: due, durationMinutes: null }, f, "Africa/Cairo")!;
    expect(w.from.toISOString()).toBe("2026-10-22T04:30:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-22T17:00:00.000Z");
  });

  it("never locks for assignments", () => {
    expect(lockWindow({ type: "assignment", dueAt: new Date(), durationMinutes: null }, f, "Africa/Cairo")).toBeNull();
  });
});

describe("material search", () => {
  it("builds an OR query without stop words", () => {
    expect(buildTsQuery("إزاي أحسب الـ subnet mask في IPv4؟")).toBe("أحسب:* | الـ | subnet:* | mask:* | ipv4:*");
    expect(buildTsQuery("في من على")).toBeNull();
  });

  it("chunks text and keeps page numbers", () => {
    const text = "[p.1]\nIntro to routing and switching basics.\n\n[p.2]\n" + "Distance vector routing protocols. ".repeat(80);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.page).toBe(1);
    expect(chunks.at(-1)!.page).toBe(2);
    expect(chunks.every((c) => c.content.length <= 1900)).toBe(true);
  });
});

describe("telegram formatting", () => {
  it("converts markdown to safe HTML", () => {
    const html = mdToTelegramHtml("**Step 1**: use `x<y`\n```python\nprint(1 < 2)\n```");
    expect(html).toBe('<b>Step 1</b>: use <code>x&lt;y</code>\n<pre><code class="language-python">print(1 &lt; 2)</code></pre>');
  });

  it("never splits inside a code fence", () => {
    const md = "Intro\n\n```js\n" + "console.log('line');\n".repeat(400) + "```\nend";
    const parts = splitMarkdown(md, 1000);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect((p.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe("calendar feed", () => {
  it("produces valid VEVENTs", () => {
    const ics = buildIcs("Batch", [
      {
        id: "e1",
        batchId: "b",
        courseId: null,
        course: null,
        type: "quiz",
        title: "Quiz 1, Networks",
        description: "Ch 1; Ch 2",
        dueAt: new Date("2026-10-22T11:00:00Z"),
        durationMinutes: null,
        createdFromMessageId: null,
        status: "active",
        confidence: 0.9,
        notifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date("2026-10-19T00:00:00Z"),
      },
    ]);
    expect(ics).toContain("DTSTART:20261022T110000Z");
    expect(ics).toContain("DTEND:20261022T120000Z");
    expect(ics).toContain("SUMMARY:Quiz 1\\, Networks");
  });
});

describe("dedupe titles", () => {
  it("matches re-posts, not different announcements", () => {
    expect(similarTitles("Quiz 2 - Networks", "Networks quiz 2")).toBe(true);
    expect(similarTitles("تسليم شيت 3", "تسليم الشيت 3")).toBe(true);
    expect(similarTitles("Office hours changed", "Grades of midterm are out")).toBe(false);
    expect(similarTitles("Quiz 2 - Networks", "Quiz 3 - Networks")).toBe(false);
  });
});

describe("upload limits", () => {
  it("rejects files the model can't take", () => {
    expect(checkUploads([{ data: Buffer.alloc(10), mimeType: "image/jpeg" }])).toBeNull();
    expect(checkUploads([{ data: Buffer.alloc(6 * 1024 * 1024), mimeType: "image/png" }])).toContain("5MB");
    expect(checkUploads([{ data: Buffer.alloc(10), mimeType: "application/vnd.ms-powerpoint" }])).toContain("مش مدعوم");
  });
});
