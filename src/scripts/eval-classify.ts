/**
 * Measures classification quality on a labelled test set (MVP gate: ≥ 90% accuracy, zero missed deadlines).
 *
 *   npm run eval:classify -- testset.jsonl
 *
 * Each line: {"text": "...", "label": "quiz", "sender": "instructor"?}
 * Needs ANTHROPIC_API_KEY (and the usual env vars, any value for the Telegram token).
 */
import { readFileSync } from "node:fs";
import { classifyMessage } from "../pipeline/classify.js";
import { shouldClassify } from "../pipeline/prefilter.js";

const DEADLINE_CLASSES = new Set(["assignment", "quiz", "exam", "schedule_change"]);

interface Row {
  text: string;
  label: string;
  sender?: string;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run eval:classify -- testset.jsonl");
  process.exit(1);
}
const rows: Row[] = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => r.label);

async function predict(r: Row): Promise<string> {
  const senderIsInstructor = r.sender === "instructor";
  const hasMedia = r.text.includes("[file]");
  if (!shouldClassify({ text: r.text, hasMedia, isReplyToTrackedMessage: false, senderIsInstructor })) return "noise";
  const res = await classifyMessage({ text: r.text.replace("[file]", ""), fileTexts: [], senderIsInstructor });
  return res.type;
}

const results: { row: Row; pred: string }[] = [];
const queue = [...rows];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) results.push({ row: r, pred: await predict(r) });
  }),
);

const correct = results.filter((x) => x.pred === x.row.label).length;
const missed = results.filter((x) => DEADLINE_CLASSES.has(x.row.label) && (x.pred === "noise" || x.pred === "material"));
const falseAlarms = results.filter((x) => x.row.label === "noise" && DEADLINE_CLASSES.has(x.pred));

console.log(`accuracy: ${correct}/${results.length} = ${((100 * correct) / results.length).toFixed(1)}%`);
console.log(`missed deadlines: ${missed.length}`);
for (const m of missed) console.log(`  MISSED [${m.row.label} → ${m.pred}] ${m.row.text.slice(0, 120).replace(/\n/g, " ")}`);
console.log(`false alarms (noise → event): ${falseAlarms.length}`);
for (const m of falseAlarms) console.log(`  FALSE [${m.pred}] ${m.row.text.slice(0, 120).replace(/\n/g, " ")}`);
for (const m of results.filter((x) => x.pred !== x.row.label && !missed.includes(x) && !falseAlarms.includes(x))) {
  console.log(`  other [${m.row.label} → ${m.pred}] ${m.row.text.slice(0, 100).replace(/\n/g, " ")}`);
}
process.exit(correct / results.length >= 0.9 && missed.length === 0 ? 0 : 1);
