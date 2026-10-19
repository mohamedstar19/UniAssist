/**
 * Turns a WhatsApp "Export chat" .txt file into a JSONL test set to label by hand.
 *
 *   npx tsx src/scripts/import-whatsapp-export.ts chat.txt > testset.jsonl
 *
 * Then fill "label" on every line with one of:
 *   assignment | quiz | exam | schedule_change | announcement | material | noise
 * and run:  npm run eval:classify -- testset.jsonl
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx src/scripts/import-whatsapp-export.ts <chat.txt>");
  process.exit(1);
}

// Android: "19/10/2026, 2:30 pm - Name: text"   iOS: "[19/10/2026, 14:30:05] Name: text"
const LINE = /^‎?\[?(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?|ص|م)?)\]?\s*(?:-\s*)?([^:]{1,60}):\s([\s\S]*)$/i;

const out: { sentAt: string; sender: string; text: string; label: string }[] = [];
for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = raw.match(LINE);
  if (m) {
    out.push({ sentAt: `${m[1]} ${m[2]}`, sender: m[3]!.trim(), text: m[4]!.trim(), label: "" });
  } else if (out.length && raw.trim()) {
    out[out.length - 1]!.text += `\n${raw}`;
  }
}
for (const row of out) {
  if (/<(Media omitted|attached|تم استبعاد الوسائط)>|\.(pdf|jpg|png)\s*\(file attached\)/i.test(row.text)) row.text += " [file]";
  console.log(JSON.stringify(row));
}
console.error(`${out.length} messages`);
