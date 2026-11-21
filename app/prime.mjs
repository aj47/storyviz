// Warm the response cache with each pack's sample text, using the same request shape the page sends on first load.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const only = process.argv[2];
function paragraphs(text) {
  const out = []; const re = /[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*/g; let m;
  while ((m = re.exec(text))) if (m[0].trim()) out.push(m[0].trim());
  return out;
}
async function run(url, body, label) {
  const t0 = Date.now(); const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text(); const done = text.split('\n\n').map((r) => r.replace(/^data: /, '')).filter(Boolean).map((r) => { try { return JSON.parse(r); } catch { return {}; } }).find((e) => e.type === 'done' || e.type === 'error');
  console.log(label, Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(done || {}).slice(0, 160));
}
const jobs = [];
for (const f of fs.readdirSync(path.join(ROOT, 'packs'))) {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', f), 'utf8'));
  if (only && p.id !== only) continue;
  const paras = paragraphs(p.placeholder || '');
  paras.forEach((text, idx) => { if (text.length >= 12) jobs.push(() => run('/api/scene', { mode: p.visual, style: 'clay', strict: true, kind: p.name, index: idx, total: paras.length, context: paras.slice(0, idx).join('\n\n'), cast: '', paragraph: text }, `${p.id} scene ${idx + 1}`)); });
  jobs.push(() => run('/api/coach', { pack: p.id, text: p.placeholder }, `${p.id} coach`));
}
const N = 6; let i = 0;
await Promise.all(Array.from({ length: N }, async () => { while (i < jobs.length) await jobs[i++](); }));
