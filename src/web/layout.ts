import { esc } from "../notify/format.js";

/** Shared HTML shell (Arabic, RTL, light/dark) for the public and admin pages. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · UniAssist</title>
<style>
:root{--bg:#f6f7fb;--fg:#1d2433;--muted:#667085;--card:#fff;--line:#e4e7ec;--accent:#3056d3;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e6e9f0;--muted:#98a2b3;--card:#171e2e;--line:#273046;--accent:#7c9cff;--chip:#1f2940}}
*{box-sizing:border-box}code{direction:ltr;unicode-bidi:isolate}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:1.4rem;margin:8px 0}
h2{font-size:1.1rem;margin:24px 0 8px}h2.inline{display:inline;margin:0}h3{margin:4px 0;font-size:1rem}
a{color:var(--accent)}.ics{font-size:.9rem;text-decoration:none}
.chips{display:flex;gap:8px;overflow-x:auto;padding:4px 0}.chip{white-space:nowrap;padding:4px 12px;border-radius:999px;background:var(--chip);text-decoration:none;color:var(--fg);font-size:.9rem}.chip.on{background:var(--accent);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.card.past{opacity:.6}.card.cancelled h3{text-decoration:line-through}.card p{margin:6px 0 0;color:var(--muted);font-size:.95rem}
.meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.85rem}.course{font-weight:600}
.tag{padding:1px 8px;border-radius:6px;background:var(--chip)}.t-exam{background:#fde2e2;color:#9b1c1c}.t-quiz{background:#fff1d6;color:#8a5a00}.t-assignment{background:#dcf5e7;color:#0f5c36}.t-cancel{background:#eee;color:#555}
@media (prefers-color-scheme:dark){.t-exam{background:#4a1d1d;color:#ffb4b4}.t-quiz{background:#45360f;color:#ffd98a}.t-assignment{background:#143d2a;color:#a6f0c6}.t-cancel{background:#333;color:#bbb}}
.due{font-size:.95rem}details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 14px;margin:8px 0}summary{cursor:pointer;font-weight:600}
.files{margin:8px 0;padding-inline-start:18px}.files li{margin:4px 0}.files small,.due small{color:var(--muted)}
.empty{color:var(--muted)}footer{margin:32px 0 8px;color:var(--muted);font-size:.8rem;text-align:center}
</style></head><body><main>${body}</main></body></html>`;
}
