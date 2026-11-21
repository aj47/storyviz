import { Stage, STYLES, STYLE_ORDER } from './scene.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ta = $('#text');

const S = {
  packs: [], pack: null, strict: localStorage.getItem('sv.strict') !== '0', cycling: true, styleIdx: 0,
  scenes: new Map(), seq: 0, cur: 0, shown: null, paras: [],
  coach: { seq: 0, shownSeq: 0, runs: new Map(), tips: [], good: [], hot: null },
};

window.__sv = S; // for debugging from the console
const stage = new Stage($('#stage'), {
  onTitle: (t) => { $('#title').textContent = t; },
  onShot: (o) => showShot(o),
});

// ---------- text helpers ----------
function paragraphs(text) {
  const out = []; const re = /[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*/g; let m;
  while ((m = re.exec(text))) if (m[0].trim()) out.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  return out;
}
const keyOf = (text) => `${S.pack.id}|${S.strict ? 1 : 0}|${text}`;
function syllables(w) { w = w.toLowerCase().replace(/[^a-z]/g, ''); if (!w) return 0; const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g); return Math.max(1, m ? m.length : 1); }
function stats(text) {
  const words = text.match(/[A-Za-z0-9'’-]+/g) || []; const sents = text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 1);
  const w = words.length, s = Math.max(1, sents.length); const syl = words.reduce((a, x) => a + syllables(x), 0);
  const grade = w ? Math.max(0, 0.39 * (w / s) + 11.8 * (syl / w) - 15.59) : 0; const secs = Math.round(w / 2.6);
  return { w, s: w ? s : 0, avg: w ? (w / s) : 0, grade, secs };
}

// ---------- packs ----------
async function boot() {
  S.packs = await (await fetch('/api/packs')).json();
  $('#tabs').innerHTML = S.packs.map((p) => `<button data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPack(b.dataset.id); });
  const q = new URLSearchParams(location.search);
  if (q.get('hold')) { const im = new Image(); im.hidden = true; im.src = '/api/hold?ms=' + Number(q.get('hold')); document.body.appendChild(im); }
  setStrictLabel(); setStyle(Math.max(0, STYLE_ORDER.indexOf(q.get('style'))));
  if (q.get('style') || q.has('nocycle')) { S.cycling = false; $('#cycleBtn').textContent = 'Cycle styles'; }
  if (q.has('reset')) Object.keys(localStorage).filter((k) => k.startsWith('sv.')).forEach((k) => localStorage.removeItem(k));
  setPack(q.get('pack') || localStorage.getItem('sv.pack') || S.packs[0]?.id);
  if (q.has('autotype')) autotype(S.pack.placeholder || '', Number(q.get('autotype')) || 16);
  if (q.get('p')) { const p = S.paras[Number(q.get('p')) - 1]; if (p) { ta.setSelectionRange(p.start, p.start); syncCurrent(); renderBackdrop(); renderPages(); showCurrent(); } }
  setInterval(() => { if (S.cycling && !document.hidden) setStyle(S.styleIdx + 1); }, 7000);
  setInterval(tick, 250);
}

function setPack(id) {
  const p = S.packs.find((x) => x.id === id) || S.packs[0]; if (!p) return;
  if (S.pack) localStorage.setItem('sv.text.' + S.pack.id, ta.value);
  S.pack = p; localStorage.setItem('sv.pack', p.id);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.id === p.id));
  $('#blurb').textContent = p.blurb || '';
  ta.value = localStorage.getItem('sv.text.' + p.id) ?? p.placeholder ?? '';
  ta.setSelectionRange(0, 0); ta.scrollTop = 0;
  stage.setMode(p.visual); stage.clear(); S.shown = null; $('#title').textContent = ''; showShot(null);
  resetCoach(); renderRules();
  onText(true);
}

// ---------- styles ----------
function setStyle(i) {
  S.styleIdx = ((i % STYLE_ORDER.length) + STYLE_ORDER.length) % STYLE_ORDER.length;
  const name = STYLE_ORDER[S.styleIdx]; stage.setStyle(name);
  $('#styleChip').textContent = 'Style: ' + STYLES[name].label;
}
$('#styleChip').onclick = () => setStyle(S.styleIdx + 1);
$('#cycleBtn').onclick = () => { S.cycling = !S.cycling; $('#cycleBtn').textContent = S.cycling ? 'Pause styles' : 'Cycle styles'; };
function setStrictLabel() { $('#strictBtn').textContent = S.strict ? 'Strict: draws only what you wrote' : 'Free: fills in the gaps'; $('#strictBtn').classList.toggle('on', S.strict); }
$('#strictBtn').onclick = () => { S.strict = !S.strict; localStorage.setItem('sv.strict', S.strict ? '1' : '0'); setStrictLabel(); schedule(); };

// ---------- editor ----------
let sceneTimer = 0, coachTimer = 0;
function onText(immediate = false) {
  if (S.pack) localStorage.setItem('sv.text.' + S.pack.id, ta.value);
  S.paras = paragraphs(ta.value); syncCurrent(); renderStats(); renderBackdrop(); renderPages();
  clearTimeout(sceneTimer); sceneTimer = setTimeout(schedule, immediate ? 50 : 900);
  clearTimeout(coachTimer); coachTimer = setTimeout(runCoach, immediate ? 200 : 1600);
}
ta.addEventListener('input', () => onText());
ta.addEventListener('scroll', () => { $('#backdrop').scrollTop = ta.scrollTop; });
for (const ev of ['keyup', 'click', 'focus']) ta.addEventListener(ev, () => { if (syncCurrent()) { renderBackdrop(); renderPages(); showCurrent(); } });

function syncCurrent() {
  const pos = ta.selectionStart; let idx = S.paras.findIndex((p) => pos >= p.start && pos <= p.end + 1);
  if (idx < 0) { idx = S.paras.findIndex((p) => p.start > pos) - 1; if (idx < 0) idx = Math.max(0, S.paras.length - 1); }
  const changed = idx !== S.cur; S.cur = idx; return changed;
}

function renderStats() {
  const st = stats(ta.value); const mm = Math.floor(st.secs / 60), ss = String(st.secs % 60).padStart(2, '0');
  $('#stats').innerHTML = `<span><b>${st.w}</b> words</span><span><b>${st.s}</b> sentences</span><span><b>${st.avg.toFixed(1)}</b> words a sentence</span><span><b>${mm}:${ss}</b> read aloud</span><span>grade <b>${st.grade.toFixed(1)}</b></span>`;
}

function renderBackdrop() {
  const text = ta.value; const marks = [];
  const add = (quote, cls) => { const i = findQuote(text, quote); if (i >= 0) marks.push({ a: i, b: i + quote.length, cls }); };
  S.coach.tips.forEach((t) => add(t.quote, 'tip' + (S.coach.hot === t ? ' hot' : '')));
  S.coach.good.forEach((t) => add(t.quote, 'good'));
  marks.sort((x, y) => x.a - y.a);
  const cur = S.paras[S.cur]; let html = '', pos = 0;
  const put = (a, b, cls) => {
    if (b <= a) return; let seg = esc(text.slice(a, b));
    if (cls) seg = `<mark class="${cls}">${seg}</mark>`;
    html += seg;
  };
  let open = false;
  const openCur = (at) => { if (cur && !open && at >= cur.start && at < cur.end) { html += '<span class="cur">'; open = true; } };
  const closeCur = (at) => { if (open && at >= cur.end) { html += '</span>'; open = false; } };
  const cuts = new Set([0, text.length]); if (cur) { cuts.add(cur.start); cuts.add(cur.end); }
  const clean = []; let last = 0;
  for (const m of marks) { if (m.a >= last) { clean.push(m); last = m.b; cuts.add(m.a); cuts.add(m.b); } }
  const pts = [...cuts].sort((x, y) => x - y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]; closeCur(a); openCur(a);
    const m = clean.find((k) => a >= k.a && b <= k.b); put(a, b, m?.cls);
  }
  if (open) html += '</span>';
  $('#backdrop').innerHTML = html + '\n'; $('#backdrop').scrollTop = ta.scrollTop; pos = 0;
}
function findQuote(text, quote) {
  if (!quote) return -1; let i = text.indexOf(quote); if (i >= 0) return i;
  return text.toLowerCase().indexOf(String(quote).toLowerCase());
}

// ---------- scenes ----------
function sceneFor(idx) {
  const p = S.paras[idx]; if (!p) return null;
  const exact = S.scenes.get(keyOf(p.text)); if (exact && exact.lines.length) return exact;
  let best = null;
  for (const sc of S.scenes.values()) if (sc.pack === S.pack.id && sc.idx === idx && sc.lines.length && (!best || sc.seq > best.seq)) best = sc;
  return best || exact || null;
}
function activeFor(idx) { const p = S.paras[idx]; return p ? S.scenes.get(keyOf(p.text)) : null; }

function schedule() {
  if (!S.pack) return;
  const order = [S.cur, ...S.paras.map((_, i) => i).filter((i) => i !== S.cur)];
  const wanted = new Set(S.paras.map((p) => keyOf(p.text)));
  // Keep the oldest and newest in-flight request per paragraph; drop the ones in between.
  const flying = [...S.scenes.values()].filter((sc) => sc.status === 'wait' && !wanted.has(sc.key));
  const byIdx = new Map(); flying.forEach((sc) => { if (!byIdx.has(sc.idx)) byIdx.set(sc.idx, []); byIdx.get(sc.idx).push(sc); });
  for (const list of byIdx.values()) { list.sort((a, b) => a.seq - b.seq); list.slice(1).forEach((sc) => { sc.ctrl.abort(); S.scenes.delete(sc.key); }); }
  let live = [...S.scenes.values()].filter((sc) => sc.status === 'wait' || sc.status === 'gen').length;
  for (const i of order) {
    const p = S.paras[i]; if (!p || p.text.length < 12) continue;
    const key = keyOf(p.text); if (S.scenes.has(key)) continue;
    if (live >= 5) break;
    startScene(i, p.text, key); live++;
  }
  renderPages(); showCurrent();
}

async function startScene(idx, text, key) {
  const sc = { key, idx, pack: S.pack.id, seq: ++S.seq, text, lines: [], raw: [], status: 'wait', t0: performance.now(), waitMs: 0, genStart: 0, chars: 0, ctrl: new AbortController(), shot: null };
  S.scenes.set(key, sc);
  const prev = idx > 0 ? sceneFor(idx - 1) : null;
  const body = {
    mode: S.pack.visual, style: STYLE_ORDER[S.styleIdx], strict: S.strict, kind: S.pack.name, index: idx, total: S.paras.length,
    context: S.paras.slice(0, idx).map((p) => p.text).join('\n\n'),
    cast: prev ? prev.raw.filter((r) => r.includes('"t":"obj"') && !r.includes('"ghost":true')).slice(0, 5).join('\n') : '',
    paragraph: text,
  };
  try {
    await sse('/api/scene', body, sc.ctrl.signal, (ev) => {
      if (ev.type === 'wait') sc.waitMs = ev.ms;
      else if (ev.type === 'first') { sc.status = 'gen'; sc.waitMs = ev.waitMs; sc.genStart = performance.now(); sc.cached = Boolean(ev.cached); }
      else if (ev.type === 'line') {
        const o = parseLine(ev.raw); if (!o) return;
        sc.lines.push(o); sc.raw.push(ev.raw); sc.chars += ev.raw.length; if (o.t === 'shot') sc.shot = o;
        if (sceneFor(S.cur) === sc) { if (S.shown === sc) stage.addLine(o, true); else showCurrent(); }
        renderPages();
      } else if (ev.type === 'done') { sc.status = 'done'; sc.done = ev; }
      else if (ev.type === 'error') { sc.status = 'error'; sc.error = ev.message; }
    });
    if (sc.status !== 'done' && sc.status !== 'error') sc.status = sc.lines.length ? 'done' : 'error';
  } catch (e) { if (sc.ctrl.signal.aborted) return; sc.status = 'error'; sc.error = String(e.message || e); }
  renderPages(); schedule();
}

function parseLine(raw) {
  let s = raw.trim().replace(/,\s*$/, ''); if (!s.startsWith('{')) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function showCurrent() {
  const sc = sceneFor(S.cur);
  if (sc === S.shown) return;
  S.shown = sc; showShot(null);
  if (!sc || !sc.lines.length) { if (!sc) { stage.clear(); $('#title').textContent = ''; } return; }
  stage.load(sc.lines, true);
}

function showShot(o) {
  const on = Boolean(o) && S.pack?.visual === 'storyboard';
  $('#phone').hidden = !on; if (!on) return;
  $('#beat').textContent = o.beat || ''; $('#sec').textContent = o.sec ? `${o.sec}s` : ''; $('#caption').textContent = o.text || '';
}

function renderPages() {
  const el = $('#pages'); let total = 0;
  el.innerHTML = S.paras.map((p, i) => {
    const sc = sceneFor(i), act = activeFor(i);
    const busy = act && (act.status === 'wait' || act.status === 'gen');
    const shot = sc?.shot; if (shot?.sec) total += Number(shot.sec) || 0;
    const label = shot ? `${i + 1} · ${esc(shot.beat || 'beat')} ${shot.sec ? shot.sec + 's' : ''}` : String(i + 1);
    return `<button data-i="${i}" class="${i === S.cur ? 'on' : ''} ${sc?.lines.length ? 'ready' : ''} ${busy ? 'busy' : ''}">${label}</button>`;
  }).join('') + (total ? `<span class="total">${total}s total</span>` : '');
}
$('#pages').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; const p = S.paras[Number(b.dataset.i)]; if (!p) return;
  ta.focus(); ta.setSelectionRange(p.end, p.end); syncCurrent(); renderBackdrop(); renderPages(); showCurrent();
});

function tick() {
  const act = activeFor(S.cur), shown = S.shown; const hud = $('#hud'); let big = '–', small = 'Write something to draw', cls = '';
  const sc = act || shown;
  if (sc) {
    if (sc.status === 'wait') { cls = 'wait'; big = `${((performance.now() - sc.t0) / 1000).toFixed(0)}<small>s in queue</small>`; small = 'Waiting for a Cerebras slot'; }
    else if (sc.status === 'gen') {
      const secs = Math.max(0.05, (performance.now() - sc.genStart) / 1000); cls = 'gen';
      big = sc.cached ? '…' : `≈${Math.round(sc.chars / 1.85 / secs)}<small>tokens/s</small>`; small = sc.cached ? 'Replaying from cache' : `${sc.lines.length} lines in ${secs.toFixed(1)}s`;
    } else if (sc.status === 'done' && sc.done) {
      big = `≈${sc.done.tps}<small>tokens/s</small>`;
      small = sc.cached ? `Replayed from cache · first drawn in ${(sc.done.genMs / 1000).toFixed(1)}s`
        : `${sc.lines.length} lines in ${(sc.done.genMs / 1000).toFixed(1)}s · waited ${(sc.done.waitMs / 1000).toFixed(0)}s`;
    } else if (sc.status === 'error') { big = '!'; small = (sc.error || 'Scene failed').slice(0, 60); }
  }
  hud.className = 'overlay top-right hud ' + cls; $('#hudBig').innerHTML = big; $('#hudSmall').textContent = small;
  const flying = [...S.scenes.values()].filter((x) => x.status === 'wait' || x.status === 'gen').length;
  const stale = shown && act && shown !== act ? 'Showing the previous version while the new one draws. ' : '';
  $('#status').textContent = stale + (flying ? `${flying} scene${flying > 1 ? 's' : ''} on the way` : '');
  const c = S.coach; const runs = [...c.runs.values()];
  $('#coachStatus').textContent = runs.some((r) => r.status === 'gen') ? 'reading…' : runs.some((r) => r.status === 'wait') ? `in queue ${Math.round((performance.now() - Math.min(...runs.filter((r) => r.status === 'wait').map((r) => r.t0))) / 1000)}s` : (c.lastDone ? `≈${c.lastDone.tps} tokens/s` : '');
}

// ---------- coach ----------
function resetCoach() {
  const c = S.coach; c.runs.forEach((r) => r.ctrl.abort()); c.runs.clear(); c.tips = []; c.good = []; c.hot = null; c.shownSeq = 0; c.lastDone = null;
  for (const id of ['scores', 'verdict', 'stages', 'tips', 'good', 'asks', 'next']) $('#' + id).innerHTML = '';
  for (const id of ['stagesBlock', 'tipsBlock', 'goodBlock', 'asksBlock', 'nextBlock']) $('#' + id).hidden = true;
  if (S.pack?.structure) { $('#structureName').textContent = S.pack.structure.name; renderStages({}); }
}
function renderStages(states) {
  const st = S.pack.structure; if (!st) return; $('#stagesBlock').hidden = false;
  $('#stages').innerHTML = st.stages.map((g) => { const s = states[g.id]; return `<div class="stg ${s?.state || ''}"><i></i><div>${esc(g.label)}<small>${esc(s?.note || g.hint || '')}</small></div></div>`; }).join('');
}
function renderRules() {
  const p = S.pack; const src = Object.fromEntries(p.sources.map((s) => [s.id, s]));
  $('#rulesSummary').textContent = `All ${p.rules.length} rules and their sources`;
  $('#rules').innerHTML = p.rules.map((r) => `<div class="r"><b>${esc(r.name)}</b>${esc(r.rule)} <span>(${esc(src[r.source]?.title || r.source)})</span></div>`).join('') +
    `<div class="srcs">${p.sources.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}${s.author ? ', ' + esc(s.author) : ''}</a>` : `<span>${esc(s.title)}</span>`).join('')}</div>`;
}

async function runCoach() {
  const c = S.coach; const text = ta.value; if (!S.pack || text.trim().length < 3) return;
  if ([...c.runs.values()].some((r) => r.text === text && r.pack === S.pack.id)) return;
  const waiting = [...c.runs.values()].filter((r) => r.status === 'wait').sort((a, b) => a.seq - b.seq);
  waiting.slice(1).forEach((r) => { r.ctrl.abort(); c.runs.delete(r.seq); });
  const run = { seq: ++c.seq, text, pack: S.pack.id, status: 'wait', t0: performance.now(), ctrl: new AbortController(), states: {} };
  c.runs.set(run.seq, run);
  try {
    await sse('/api/coach', { pack: S.pack.id, text }, run.ctrl.signal, (ev) => {
      if (ev.type === 'first') run.status = 'gen';
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (o) coachLine(run, o); }
      else if (ev.type === 'done') { run.status = 'done'; if (run.seq >= c.shownSeq) c.lastDone = ev; }
      else if (ev.type === 'error') run.status = 'error';
    });
  } catch { /* aborted or failed */ }
  if (run.status !== 'done') run.status = 'error';
  c.runs.delete(run.seq);
}

function coachLine(run, o) {
  const c = S.coach; if (run.pack !== S.pack.id || run.seq < c.shownSeq) return;
  if (run.seq > c.shownSeq) {
    c.shownSeq = run.seq; c.tips = []; c.good = [];
    for (const id of ['tips', 'good', 'asks', 'next']) $('#' + id).innerHTML = '';
    for (const id of ['tipsBlock', 'goodBlock', 'asksBlock', 'nextBlock']) $('#' + id).hidden = true;
  }
  const rule = S.pack.rules.find((r) => r.id === o.rule); const src = rule && S.pack.sources.find((s) => s.id === rule.source);
  const head = rule ? `<div class="rule">${esc(rule.name)}</div><div class="src">${src?.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a>` : esc(src?.title || '')}</div>` : '';
  if (o.k === 'tip' && o.tip) {
    c.tips.push(o); $('#tipsBlock').hidden = false;
    const el = document.createElement('div'); el.className = 'card' + (findQuote(ta.value, o.quote) < 0 ? ' stale' : '');
    el.innerHTML = `${head}${o.quote ? `<div class="quote">${esc(o.quote)}</div>` : ''}<div class="tip">${esc(o.tip)}</div>${o.fix && o.quote ? `<div class="fix"><span>${esc(o.fix)}</span><button>Apply</button></div>` : ''}`;
    el.onmouseenter = () => { c.hot = o; renderBackdrop(); }; el.onmouseleave = () => { c.hot = null; renderBackdrop(); };
    el.querySelector('.quote')?.addEventListener('click', () => selectQuote(o.quote));
    el.querySelector('button')?.addEventListener('click', () => { applyFix(o); el.remove(); });
    $('#tips').appendChild(el); renderBackdrop();
  } else if (o.k === 'good' && o.note) {
    c.good.push(o); $('#goodBlock').hidden = false;
    const el = document.createElement('div'); el.className = 'card good';
    el.innerHTML = `${head}${o.quote ? `<div class="quote">${esc(o.quote)}</div>` : ''}<div class="tip">${esc(o.note)}</div>`;
    $('#good').appendChild(el); renderBackdrop();
  } else if (o.k === 'stage' && o.id) { run.states[o.id] = o; renderStages(run.states); }
  else if (o.k === 'ask' && o.text) { $('#asksBlock').hidden = false; const el = document.createElement('div'); el.className = 'line'; el.textContent = o.text; $('#asks').appendChild(el); }
  else if (o.k === 'next' && o.text) {
    $('#nextBlock').hidden = false; const el = document.createElement('button'); el.className = 'line'; el.textContent = o.text;
    el.onclick = () => { const v = ta.value.replace(/\s+$/, ''); ta.value = v + (v ? ' ' : '') + o.text; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); el.remove(); onText(); };
    $('#next').appendChild(el);
  } else if (o.k === 'score') {
    const cell = (n, l) => `<div class="score"><div class="n">${Math.round(Number(n) || 0)}</div><div class="l">${l}</div><div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(n) || 0))}%"></i></div></div>`;
    $('#scores').innerHTML = cell(o.specific, 'Specific') + cell(o.clear, 'Clear') + cell(o.structure, 'Structure'); $('#verdict').textContent = o.line || '';
  }
}
function selectQuote(q) { const i = findQuote(ta.value, q); if (i < 0) return; ta.focus(); ta.setSelectionRange(i, i + q.length); syncCurrent(); renderBackdrop(); renderPages(); showCurrent(); }
function applyFix(o) {
  const i = findQuote(ta.value, o.quote); if (i < 0) return;
  ta.value = ta.value.slice(0, i) + o.fix + ta.value.slice(i + o.quote.length);
  S.coach.tips = S.coach.tips.filter((t) => t !== o); ta.focus(); ta.setSelectionRange(i, i + o.fix.length); onText();
}

// Types text into the editor at a steady pace (for recording a take): add ?autotype=16 (characters a second).
function autotype(text, cps) {
  ta.value = ''; onText(true); let i = 0;
  const step = () => {
    if (i >= text.length) return;
    ta.value += text[i++]; ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollTop = ta.scrollHeight; onText();
    setTimeout(step, (1000 / cps) * (/[.!?\n]/.test(text[i - 1]) ? 4 : 0.6 + Math.random() * 0.8));
  };
  setTimeout(step, 600);
}

// ---------- transport ----------
async function sse(url, body, signal, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const row = buf.slice(0, i); buf = buf.slice(i + 2);
      if (row.startsWith('data:')) { try { onEvent(JSON.parse(row.slice(5))); } catch (e) { console.warn(e); } }
    }
  }
}

boot();
