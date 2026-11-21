import { Stage, STYLES, STYLE_ORDER } from './scene.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ta = $('#text');
const store = { get: (k) => localStorage.getItem('sv.' + k), set: (k, v) => localStorage.setItem('sv.' + k, v) };
const flag = (k, d) => { const v = store.get(k); return v == null ? d : v === '1'; };

const S = {
  packs: [], pack: null, project: null, projects: [],
  strict: flag('strict', true), restyle: flag('restyle', true), live: flag('live', true), styleIdx: 0,
  scenes: new Map(), seq: 0, cur: 0, shown: null, paras: [],
  coach: { seq: 0, shownSeq: 0, runs: new Map(), tips: [], good: [], hot: null, tab: 'tips', states: {}, saved: null },
};
const tipEls = new WeakMap();

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
  return { w, grade, secs };
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- boot ----------
async function boot() {
  [S.packs, S.projects] = await Promise.all([api('GET', '/api/packs'), api('GET', '/api/projects')]);
  const q = new URLSearchParams(location.search);
  if (q.get('hold')) { const im = new Image(); im.hidden = true; im.src = '/api/hold?ms=' + Number(q.get('hold')); document.body.appendChild(im); }
  if (q.get('style') || q.has('nocycle')) S.restyle = false;
  setStyle(Math.max(0, STYLE_ORDER.indexOf(q.get('style') || store.get('style'))));
  $('#restyleSw').checked = S.restyle; $('#fillSw').checked = !S.strict; $('#liveSw').checked = S.live;
  buildMenus();

  const want = (location.hash.match(/p=([a-z0-9]+)/) || [])[1] || store.get('last');
  const hit = S.projects.find((p) => p.id === want) || S.projects[0];
  if (hit) await openProject(hit.id);
  else { const p = S.packs[0]; await createProject(p.id, 'Sample story', p.placeholder || ''); }

  if (q.has('autotype')) {
    // Recording a take retypes the sample, so it gets its own project and never overwrites real work.
    if (!S.project.name.startsWith('Take: ')) await createProject(S.pack.id, 'Take: ' + S.pack.name);
    autotype(S.pack.placeholder || '', Number(q.get('autotype')) || 16);
  }
  if (q.get('p')) { const p = S.paras[Number(q.get('p')) - 1]; if (p) { ta.setSelectionRange(p.start, p.start); moved(true); } }
  if (q.get('tab')) setTab(q.get('tab'));
  if (q.has('projects')) showProjects();
  setInterval(() => { if (S.restyle && !document.hidden) setStyle(S.styleIdx + 1); }, 7000);
  setInterval(tick, 250);
}

// ---------- projects ----------
const packById = (id) => S.packs.find((p) => p.id === id) || S.packs[0];
const newId = () => (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).slice(0, 14);

async function createProject(packId, name, text = '') {
  await saveNow();
  const now = Date.now();
  const p = { id: newId(), name: (name || '').trim() || 'Untitled', pack: packById(packId).id, text, scenes: [], coach: null, createdAt: now, updatedAt: now };
  await api('PUT', '/api/projects/' + p.id, p);
  loadProject(p); refreshProjects();
}

async function openProject(id) {
  if (S.project?.id === id) return;
  await saveNow();
  loadProject(await api('GET', '/api/projects/' + id));
}

function loadProject(p) {
  S.project = p; S.pack = packById(p.pack);
  store.set('last', p.id); history.replaceState(null, '', location.pathname + location.search + '#p=' + p.id);
  setName(p.name); setSaveState('saved');
  for (const sc of S.scenes.values()) sc.ctrl?.abort();
  S.scenes.clear();
  for (const s of p.scenes || []) {
    const lines = (s.raw || []).map(parseLine).filter(Boolean); if (!lines.length) continue;
    S.scenes.set(s.key, { key: s.key, idx: s.idx, pack: p.pack, seq: ++S.seq, text: s.text, lines, raw: s.raw, status: 'done', shot: lines.filter((o) => o.t === 'shot').pop() || null });
  }
  ta.value = p.text || ''; ta.setSelectionRange(0, 0); ta.scrollTop = 0;
  applyPack(); restoreCoach(p.coach);
  onText(true, false);
}

// Everything that depends on the writing type.
function applyPack() {
  $('#typeBtn').textContent = S.pack.name;
  $$('#typeMenu button').forEach((b) => b.classList.toggle('on', b.dataset.id === S.pack.id));
  stage.setMode(S.pack.visual); stage.clear(); S.shown = null; $('#title').textContent = ''; showShot(null);
  resetCoach(); renderRules();
}

function setType(id) {
  if (!S.project || id === S.pack.id) return;
  S.pack = packById(id); S.project.pack = S.pack.id;
  applyPack(); onText(true);
}

function setName(name) {
  const el = $('#name'); if (name != null) el.value = name;
  if (!CSS.supports('field-sizing', 'content')) el.style.width = Math.min(46, Math.max(7, el.value.length + 2)) + 'ch';
  document.title = (el.value.trim() || 'Untitled') + ' · Storyviz';
}
$('#name').addEventListener('input', () => { setName(); markDirty(); });
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); ta.focus(); } });
$('#name').addEventListener('blur', () => { if (!$('#name').value.trim()) setName('Untitled'); });

// ---------- saving ----------
let saveTimer = 0, dirty = false, saveChain = Promise.resolve();
const SAVE_LABEL = { saved: 'Saved', dirty: 'Save', saving: 'Saving…', error: 'Not saved. Retry' };
function setSaveState(state) { const b = $('#saveBtn'); b.textContent = SAVE_LABEL[state]; b.className = 'save ' + state; }
function markDirty() {
  if (!S.project) return;
  dirty = true; setSaveState('dirty');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 800);
}
function snapshot(p) {
  p.name = $('#name').value.trim() || 'Untitled'; p.text = ta.value; p.pack = S.pack.id; p.coach = S.coach.saved;
  const kept = new Map();
  S.paras.forEach((para, i) => {
    const sc = S.scenes.get(keyOf(para.text));
    if (sc && sc.status === 'done' && sc.raw.length && !kept.has(sc.key)) kept.set(sc.key, { key: sc.key, idx: i, text: para.text, raw: sc.raw });
  });
  p.scenes = [...kept.values()];
}
// Saves are queued one after another, so a slow save can never overwrite a newer one.
function saveNow() {
  clearTimeout(saveTimer);
  const p = S.project; if (!p || !dirty) return saveChain;
  dirty = false; snapshot(p); setSaveState('saving');
  const body = JSON.stringify(p);
  saveChain = saveChain.then(async () => {
    try {
      const r = await api('PUT', '/api/projects/' + p.id, body); p.updatedAt = r.updatedAt;
      const row = S.projects.find((x) => x.id === p.id); if (row) Object.assign(row, { name: p.name, pack: p.pack, updatedAt: p.updatedAt, words: (p.text.match(/\S+/g) || []).length });
      if (S.project === p && !dirty) setSaveState('saved');
    } catch (e) {
      console.warn('save failed', e);
      if (S.project === p) { dirty = true; setSaveState('error'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 4000); }
    }
  });
  return saveChain;
}
$('#saveBtn').onclick = () => { dirty = dirty || $('#saveBtn').classList.contains('error'); saveNow(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('pagehide', () => saveNow());
window.addEventListener('beforeunload', (e) => { if (dirty) { saveNow(); e.preventDefault(); } });

// ---------- project dialog ----------
async function refreshProjects() {
  try { S.projects = await api('GET', '/api/projects'); } catch (e) { console.warn(e); }
  renderProjects();
}
function renderProjects() {
  $('#projListHead').hidden = !S.projects.length;
  $('#projList').innerHTML = S.projects.map((p) => `<div class="row ${p.id === S.project?.id ? 'on' : ''}" data-id="${esc(p.id)}">
    <button class="open"><b>${esc(p.name)}</b><small>${esc(packById(p.pack).name)} · ${p.words} word${p.words === 1 ? '' : 's'} · ${ago(p.updatedAt)}</small></button>
    <button class="mini" data-act="dup">Duplicate</button><button class="mini" data-act="del">Delete</button></div>`).join('');
}
async function showProjects(focusNew = false) {
  closeMenus(); await saveNow();
  $('#newName').value = ''; renderProjects(); $('#projectsDlg').showModal();
  if (focusNew) $('#newName').focus(); else $('#projList .row.on .open, #projList .open')?.focus();
  refreshProjects();
}
$('#openBtn').onclick = () => showProjects(false);
$('#newBtn').onclick = () => showProjects(true);
$('#newTypes').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  await createProject(b.dataset.id, $('#newName').value);
  $('#projectsDlg').close(); ta.focus();
});
$('#newName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#newTypes button')?.focus(); } });
$('#projList').addEventListener('click', async (e) => {
  const row = e.target.closest('.row'), btn = e.target.closest('button'); if (!row || !btn) return;
  const id = row.dataset.id;
  if (btn.classList.contains('open')) { await openProject(id); $('#projectsDlg').close(); ta.focus(); return; }
  if (btn.dataset.act === 'dup') {
    await saveNow(); await saveChain;
    const src = await api('GET', '/api/projects/' + id);
    const copy = { ...src, id: newId(), name: (src.name + ' copy').slice(0, 80), createdAt: Date.now() };
    await api('PUT', '/api/projects/' + copy.id, copy); refreshProjects(); return;
  }
  if (btn.dataset.act === 'del') {
    if (!btn.classList.contains('sure')) { btn.classList.add('sure'); btn.textContent = 'Really delete?'; setTimeout(() => { btn.classList.remove('sure'); btn.textContent = 'Delete'; }, 3000); return; }
    const current = S.project?.id === id;
    if (current) { clearTimeout(saveTimer); dirty = false; S.project = null; }
    await saveChain; await api('DELETE', '/api/projects/' + id);
    S.projects = S.projects.filter((p) => p.id !== id);
    if (current) { if (S.projects[0]) await openProject(S.projects[0].id); else await createProject(S.packs[0].id, 'Untitled'); }
    refreshProjects();
  }
});
for (const d of $$('dialog')) d.addEventListener('click', (e) => {
  const r = d.getBoundingClientRect(); const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if ((e.target === d && outside) || e.target.closest('[data-close]')) d.close();
});

// ---------- menus, switches, shortcuts ----------
function closeMenus() { $$('.menu').forEach((m) => { m.hidden = true; }); }
function bindMenu(btn, menu) { btn.addEventListener('click', (e) => { e.stopPropagation(); const open = menu.hidden; closeMenus(); menu.hidden = !open; }); }
function buildMenus() {
  const types = S.packs.map((p) => `<button data-id="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.blurb || '')}</small></button>`).join('');
  $('#typeMenu').innerHTML = types; $('#newTypes').innerHTML = types;
  $('#styleMenu').innerHTML = STYLE_ORDER.map((n, i) => `<button data-i="${i}">${esc(STYLES[n].label)}</button>`).join('');
  bindMenu($('#typeBtn'), $('#typeMenu')); bindMenu($('#styleBtn'), $('#styleMenu'));
  $('#typeMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setType(b.dataset.id); });
  // Picking a style by hand means you want to keep it, so auto restyle switches off.
  $('#styleMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; setRestyle(false); setStyle(Number(b.dataset.i)); });
  setStyle(S.styleIdx);
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 's') { e.preventDefault(); dirty = true; saveNow(); }
  else if (e.key === 'o') { e.preventDefault(); showProjects(false); }
});

function setStyle(i) {
  S.styleIdx = ((i % STYLE_ORDER.length) + STYLE_ORDER.length) % STYLE_ORDER.length;
  const name = STYLE_ORDER[S.styleIdx]; stage.setStyle(name); store.set('style', name);
  $('#styleBtn').textContent = STYLES[name].label;
  $$('#styleMenu button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === S.styleIdx));
}
function setRestyle(on) { S.restyle = on; store.set('restyle', on ? '1' : '0'); $('#restyleSw').checked = on; }
$('#restyleSw').onchange = (e) => setRestyle(e.target.checked);
$('#fillSw').onchange = (e) => { S.strict = !e.target.checked; store.set('strict', S.strict ? '1' : '0'); schedule(); };
$('#liveSw').onchange = (e) => {
  S.live = e.target.checked; store.set('live', S.live ? '1' : '0');
  clearTimeout(coachTimer); if (S.live) runCoach(); renderCoach();
};
$('#reviewBtn').onclick = () => runCoach(true);
$('#redrawBtn').onclick = () => redraw();
$('#sampleBtn').onclick = () => { ta.value = S.pack.placeholder || ''; ta.focus(); ta.setSelectionRange(0, 0); onText(true); };

// ---------- editor ----------
let sceneTimer = 0, coachTimer = 0;
function onText(immediate = false, changed = true) {
  S.paras = paragraphs(ta.value); syncCurrent(); renderStats(); renderBackdrop(); renderPages();
  $('#sampleBtn').hidden = ta.value.length > 0 || !S.pack?.placeholder;
  S.coach.tips.forEach((t) => tipEls.get(t)?.classList.toggle('stale', findQuote(ta.value, t.quote) < 0));
  if (changed) markDirty();
  clearTimeout(sceneTimer); sceneTimer = setTimeout(schedule, immediate ? 50 : 900);
  clearTimeout(coachTimer); if (S.live) coachTimer = setTimeout(runCoach, immediate ? 200 : 1600);
  renderCoach();
}
function moved(force = false) { if (syncCurrent() || force) { renderBackdrop(); renderPages(); showCurrent(); } }
ta.addEventListener('input', () => onText());
ta.addEventListener('scroll', () => { $('#backdrop').scrollTop = ta.scrollTop; });
for (const ev of ['keyup', 'click', 'focus']) ta.addEventListener(ev, () => moved());

function syncCurrent() {
  const pos = ta.selectionStart; let idx = S.paras.findIndex((p) => pos >= p.start && pos <= p.end + 1);
  if (idx < 0) { idx = S.paras.findIndex((p) => p.start > pos) - 1; if (idx < 0) idx = Math.max(0, S.paras.length - 1); }
  const changed = idx !== S.cur; S.cur = idx; return changed;
}

function renderStats() {
  const st = stats(ta.value); if (!st.w) { $('#stats').textContent = ''; return; }
  const time = `${Math.floor(st.secs / 60)}:${String(st.secs % 60).padStart(2, '0')}`;
  $('#stats').textContent = `${st.w} word${st.w === 1 ? '' : 's'} · ${time} read aloud · grade ${st.grade.toFixed(1)}`;
}

// Paints the current paragraph and the coach's underlines behind the transparent textarea.
function renderBackdrop() {
  const text = ta.value; const marks = []; const c = S.coach;
  const add = (quote, cls) => { const i = findQuote(text, quote); if (i >= 0) marks.push({ a: i, b: i + quote.length, cls }); };
  c.tips.forEach((t) => { if (!tipEls.get(t)?.hidden) add(t.quote, 'tip' + (c.hot === t ? ' hot' : '')); });
  if (c.hot && c.good.includes(c.hot)) add(c.hot.quote, 'hot good');
  marks.sort((x, y) => x.a - y.a);
  const cur = S.paras.length > 1 ? S.paras[S.cur] : null; let html = '', open = false;
  const cuts = new Set([0, text.length]); if (cur) { cuts.add(cur.start); cuts.add(cur.end); }
  const clean = []; let last = 0;
  for (const m of marks) { if (m.a >= last) { clean.push(m); last = m.b; cuts.add(m.a); cuts.add(m.b); } }
  const pts = [...cuts].sort((x, y) => x - y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (open && a >= cur.end) { html += '</span>'; open = false; }
    if (cur && !open && a >= cur.start && a < cur.end) { html += '<span class="cur">'; open = true; }
    const m = clean.find((k) => a >= k.a && b <= k.b); const seg = esc(text.slice(a, b));
    html += m ? `<mark class="${m.cls}">${seg}</mark>` : seg;
  }
  if (open) html += '</span>';
  const bd = $('#backdrop'); bd.innerHTML = html + '\n';
  // A thin bar in the margin marks the paragraph that is on stage.
  const span = bd.querySelector('.cur'), rects = span?.getClientRects();
  if (rects?.length) {
    const box = bd.getBoundingClientRect(); const bar = document.createElement('i'); bar.className = 'bar';
    bar.style.top = rects[0].top - box.top + bd.scrollTop + 4 + 'px'; bar.style.height = rects[rects.length - 1].bottom - rects[0].top - 8 + 'px';
    bd.appendChild(bar);
  }
  bd.scrollTop = ta.scrollTop;
}
function findQuote(text, quote) {
  if (!quote) return -1; const i = text.indexOf(quote); if (i >= 0) return i;
  return text.toLowerCase().indexOf(String(quote).toLowerCase());
}

// ---------- scenes ----------
const flying = (sc) => sc.status === 'wait' || sc.status === 'gen';
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
  const queued = [...S.scenes.values()].filter((sc) => sc.status === 'wait' && !wanted.has(sc.key));
  const byIdx = new Map(); queued.forEach((sc) => { if (!byIdx.has(sc.idx)) byIdx.set(sc.idx, []); byIdx.get(sc.idx).push(sc); });
  for (const list of byIdx.values()) { list.sort((a, b) => a.seq - b.seq); list.slice(1).forEach((sc) => { sc.ctrl.abort(); S.scenes.delete(sc.key); }); }
  let live = [...S.scenes.values()].filter(flying).length;
  for (const i of order) {
    const p = S.paras[i]; if (!p || p.text.length < 12) continue;
    const key = keyOf(p.text); if (S.scenes.has(key)) continue;
    if (live >= 5) break;
    startScene(i, p.text, key); live++;
  }
  renderPages(); showCurrent();
}

async function startScene(idx, text, key, fresh = false) {
  const sc = { key, idx, pack: S.pack.id, seq: ++S.seq, text, lines: [], raw: [], status: 'wait', t0: performance.now(), waitMs: 0, genStart: 0, chars: 0, ctrl: new AbortController(), shot: null };
  S.scenes.set(key, sc);
  const prev = idx > 0 ? sceneFor(idx - 1) : null;
  const body = {
    mode: S.pack.visual, style: STYLE_ORDER[S.styleIdx], strict: S.strict, kind: S.pack.name, index: idx, total: S.paras.length,
    context: S.paras.slice(0, idx).map((p) => p.text).join('\n\n'),
    cast: prev ? prev.raw.filter((r) => r.includes('"t":"obj"') && !r.includes('"ghost":true')).slice(0, 5).join('\n') : '',
    paragraph: text, fresh,
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
  if (sc.status === 'done') {
    for (const [k, v] of S.scenes) if (k.endsWith('|old') && v.idx === idx) S.scenes.delete(k);
    markDirty();
  }
  renderPages(); schedule();
}

// Draws the current scene again. The old drawing stays on screen until the new one starts arriving.
function redraw() {
  const p = S.paras[S.cur]; if (!p || p.text.length < 12) return;
  const key = keyOf(p.text), old = S.scenes.get(key);
  if (old && flying(old)) return;
  if (old) { S.scenes.delete(key); if (old.lines.length) { old.key = key + '|old'; S.scenes.set(old.key, old); } }
  startScene(S.cur, p.text, key, true); renderPages();
}

function parseLine(raw) {
  const s = String(raw).trim().replace(/,\s*$/, ''); if (!s.startsWith('{')) return null;
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
  let total = 0;
  const html = S.paras.map((p, i) => {
    const sc = sceneFor(i), act = activeFor(i); const shot = sc?.shot; if (shot?.sec) total += Number(shot.sec) || 0;
    const label = shot && i === S.cur ? `${i + 1} · ${esc(shot.beat || 'beat')}${shot.sec ? ' ' + shot.sec + 's' : ''}` : String(i + 1);
    return `<button data-i="${i}" class="${i === S.cur ? 'on' : ''} ${sc?.lines.length ? 'ready' : ''} ${act && flying(act) ? 'busy' : ''}">${label}</button>`;
  }).join('') + (total ? `<span class="total">${total}s</span>` : '');
  $('#pages').innerHTML = S.paras.length > 1 || total ? html : '';
}
$('#pages').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; const p = S.paras[Number(b.dataset.i)]; if (!p) return;
  ta.focus(); ta.setSelectionRange(p.end, p.end); moved(true);
});

$('#hud').onclick = () => {
  const act = activeFor(S.cur); if (act?.status !== 'error') return;
  S.scenes.delete(act.key); schedule();
};

function tick() {
  const act = activeFor(S.cur), sc = act || S.shown; let big = '', small = '', cls = '', tip = '';
  if (sc?.status === 'wait') { cls = 'wait'; big = `${Math.round((performance.now() - sc.t0) / 1000)}s`; small = 'in the Cerebras queue'; }
  else if (sc?.status === 'gen') {
    const secs = Math.max(0.05, (performance.now() - sc.genStart) / 1000); cls = 'gen';
    if (sc.cached) small = 'replaying'; else { big = `≈${Math.round(sc.chars / 1.85 / secs)}`; small = 'tokens/s'; }
  } else if (sc?.status === 'done' && sc.done) {
    if (sc.cached) small = 'replayed from cache';
    else { big = `≈${sc.done.tps}`; small = `tokens/s · ${(sc.done.genMs / 1000).toFixed(1)}s`; tip = `${sc.lines.length} lines in ${(sc.done.genMs / 1000).toFixed(1)}s after ${(sc.done.waitMs / 1000).toFixed(0)}s in the queue`; }
  } else if (sc?.status === 'error') { cls = 'err'; big = '!'; small = 'Scene failed. Click to retry'; tip = sc.error || ''; }
  const hud = $('#hud'); hud.hidden = !big && !small; hud.className = 'overlay top-right hud ' + cls; hud.title = tip;
  $('#hudBig').textContent = big; $('#hudSmall').textContent = small;

  const runs = [...S.coach.runs.values()];
  const waiting = runs.filter((r) => r.status === 'wait');
  $('#coachStatus').textContent = runs.some((r) => r.phase === 'facts') ? 'checking facts on Wikipedia…' : runs.some((r) => r.status === 'gen') ? 'reading…'
    : waiting.length ? `in queue ${Math.round((performance.now() - Math.min(...waiting.map((r) => r.t0))) / 1000)}s` : '';
  $('#reviewBtn').disabled = runs.length > 0 || ta.value.trim().length < 3;
  $('#redrawBtn').disabled = !S.shown?.lines.length || Boolean(act && flying(act));
}

// ---------- coach ----------
function setTab(tab) {
  if (!['tips', 'structure', 'ideas'].includes(tab)) return;
  S.coach.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

// Only the three most important tips show at once; the rest wait behind one button.
function layoutTips() {
  const els = [...$('#tips').children]; const max = S.coach.allTips ? Infinity : 3;
  els.forEach((el, i) => { el.hidden = i >= max; });
  const more = els.length - Math.min(els.length, max);
  $('#moreTips').hidden = !more; $('#moreTips').textContent = `Show ${more} more`;
}
$('#moreTips').onclick = () => { S.coach.allTips = true; layoutTips(); renderBackdrop(); };

// Counts, empty messages and the Review button: everything in the coach that is derived from state.
function renderCoach() {
  const c = S.coach; const tips = $('#tips').children.length, ideas = $('#asks').children.length + $('#next').children.length + $('#details').children.length;
  const stages = S.pack?.structure?.stages || []; const done = stages.filter((g) => c.states[g.id]?.state === 'done').length;
  $('#tipsCount').textContent = tips || ''; $('#ideasCount').textContent = ideas || '';
  $('#stagesCount').textContent = stages.length && c.shownSeq ? `${done}/${stages.length}` : '';
  $('#reviewBtn').hidden = S.live;
  $('#detailsWrap').hidden = !$('#details').children.length;
  $('#goodWrap').hidden = !$('#good').children.length; $('#asksWrap').hidden = !$('#asks').children.length; $('#nextWrap').hidden = !$('#next').children.length;
  $('#ideasEmpty').hidden = ideas > 0;
  const empty = $('#tipsEmpty'); empty.hidden = tips > 0 || $('#good').children.length > 0;
  empty.textContent = c.runs.size ? 'Reading your draft…'
    : c.shownSeq ? 'No tips left. Keep writing.'
    : ta.value.trim().length < 3 ? 'Write a few lines and the coach will read them.'
    : S.live ? 'The coach reads your draft each time you pause.' : 'Keep improving is off. Press Review when you want notes.';
}

function resetCoach() {
  const c = S.coach; c.runs.forEach((r) => r.ctrl.abort()); c.runs.clear();
  Object.assign(c, { tips: [], good: [], hot: null, shownSeq: 0, states: {}, saved: null, allTips: false });
  for (const id of ['scores', 'verdict', 'tips', 'good', 'asks', 'next', 'details']) $('#' + id).innerHTML = '';
  $('#scores').hidden = true; $('#verdict').hidden = true; layoutTips();
  $('#structureName').textContent = S.pack?.structure?.name || 'Structure';
  renderStages(); setTab('tips'); renderCoach();
}
function restoreCoach(saved) {
  if (!saved || saved.pack !== S.pack.id || !Array.isArray(saved.lines)) return;
  const c = S.coach; const run = { seq: ++c.seq, pack: saved.pack };
  for (const o of saved.lines) { if ((o.k === 'tip' || o.k === 'fact') && findQuote(ta.value, o.quote) < 0) continue; coachLine(run, o); }
  c.shownSeq = run.seq; c.saved = saved; renderCoach();
}
function renderStages() {
  const st = S.pack?.structure; const c = S.coach;
  $('#stages').innerHTML = (st?.stages || []).map((g) => { const s = c.states[g.id]; return `<div class="stg ${esc(s?.state || '')}"><i></i><div>${esc(g.label)}<small>${esc(s?.note || g.hint || '')}</small></div></div>`; }).join('');
}
function renderRules() {
  const p = S.pack; const src = Object.fromEntries(p.sources.map((s) => [s.id, s]));
  $('#rulesBtn').textContent = `${p.rules.length} rules from ${p.sources.length} guides`;
  $('#rulesTitle').textContent = `${p.name}: the guides behind the tips`;
  $('#rules').innerHTML = p.rules.map((r) => `<div class="r"><b>${esc(r.name)}</b>${esc(r.rule)} <span>(${esc(src[r.source]?.title || r.source)})</span></div>`).join('') +
    `<div class="srcs">${p.sources.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}${s.author ? ', ' + esc(s.author) : ''}</a>` : `<span>${esc(s.title)}</span>`).join('')}</div>`;
}
$('#rulesBtn').onclick = () => $('#rulesDlg').showModal();

// force = the writer pressed Review. Without it, a draft that was already reviewed is left alone.
async function runCoach(force = false) {
  const c = S.coach; const text = ta.value; if (!S.pack || text.trim().length < 3) return;
  const reviewed = c.saved && c.saved.text === text && c.saved.pack === S.pack.id;
  if (reviewed && !force) return;
  if ([...c.runs.values()].some((r) => r.text === text && r.pack === S.pack.id)) return;
  const waiting = [...c.runs.values()].filter((r) => r.status === 'wait').sort((a, b) => a.seq - b.seq);
  waiting.slice(1).forEach((r) => { r.ctrl.abort(); c.runs.delete(r.seq); });
  const run = { seq: ++c.seq, text, pack: S.pack.id, project: S.project?.id, status: 'wait', t0: performance.now(), ctrl: new AbortController(), lines: [] };
  c.runs.set(run.seq, run); renderCoach();
  try {
    await sse('/api/coach', { pack: S.pack.id, text, fresh: Boolean(reviewed) }, run.ctrl.signal, (ev) => {
      if (ev.type === 'first') run.status = 'gen';
      else if (ev.type === 'phase') run.phase = ev.name;
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (o) { run.lines.push(o); coachLine(run, o); } }
      else if (ev.type === 'done') run.status = 'done';
      else if (ev.type === 'error') run.status = 'error';
    });
  } catch { /* aborted or failed */ }
  c.runs.delete(run.seq);
  if (run.status === 'done' && run.seq >= c.shownSeq && run.project === S.project?.id && run.pack === S.pack.id) {
    c.saved = { text: run.text, pack: run.pack, lines: run.lines }; markDirty();
  }
  renderCoach();
}

function coachLine(run, o) {
  const c = S.coach; if (run.pack !== S.pack.id || run.seq < c.shownSeq) return;
  if (run.seq > c.shownSeq) {
    c.shownSeq = run.seq; c.tips = []; c.good = []; c.hot = null; c.allTips = false;
    for (const id of ['tips', 'good', 'asks', 'next', 'details']) $('#' + id).innerHTML = '';
  }
  const rule = S.pack.rules.find((r) => r.id === o.rule); const src = rule && S.pack.sources.find((s) => s.id === rule.source);
  const link = (url, text, title = '') => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(text)}</a>` : `<span title="${esc(title)}">${esc(text)}</span>`);
  const wiki = o.url ? link(o.url, 'Wikipedia', o.title || '') : '';
  const hover = (el) => { el.onmouseenter = () => { c.hot = o; renderBackdrop(); }; el.onmouseleave = () => { c.hot = null; renderBackdrop(); }; };
  // One card shape for coach tips and failed fact checks: what to do, the rewrite, where it comes from.
  const card = (text, from, cls = '') => {
    c.tips.push(o);
    const el = document.createElement('div'); el.className = `card ${cls}` + (findQuote(ta.value, o.quote) < 0 ? ' stale' : '');
    const canFix = Boolean(o.fix && o.quote);
    el.innerHTML = `<div class="tip">${esc(text)}</div>${canFix ? `<div class="fix">${esc(o.fix)}</div>` : ''}<div class="foot"><span class="rule">${from}</span>${canFix ? '<button>Apply</button>' : ''}</div>`;
    hover(el); tipEls.set(o, el);
    el.addEventListener('click', (e) => { if (!e.target.closest('a, button')) selectQuote(o.quote); });
    el.querySelector('.foot button')?.addEventListener('click', () => { el.remove(); layoutTips(); applyFix(o); });
    if (cls) $('#tips').prepend(el); else $('#tips').appendChild(el);
    layoutTips(); renderBackdrop();
  };
  const goodLine = (html) => { c.good.push(o); const el = document.createElement('div'); el.className = 'goodline'; el.innerHTML = html; hover(el); $('#good').appendChild(el); };
  if (o.k === 'tip' && o.tip) card(o.tip, rule ? `<b>${link(src?.url, rule.name, src?.title)}</b>` : '');
  else if (o.k === 'good' && o.note) goodLine(esc(o.note));
  else if (o.k === 'fact' && o.note && o.verdict === 'true') goodLine(`Checks out: ${esc(o.note)} ${wiki}`);
  else if (o.k === 'fact' && o.note) card(o.note, `<b>${o.verdict === 'false' ? 'Fact check' : 'Could not confirm'}</b>${wiki ? ' · ' + wiki : ''}`, 'fact');
  else if (o.k === 'detail' && o.text) {
    const el = document.createElement('div'); el.className = 'detail';
    el.innerHTML = `<button class="line">${esc(o.text)}</button>${wiki ? `<span class="src">${wiki}</span>` : ''}`;
    el.querySelector('button').onclick = () => { addLine(o.text); el.remove(); renderCoach(); };
    $('#details').appendChild(el);
  } else if (o.k === 'stage' && o.id) { c.states[o.id] = o; renderStages(); }
  else if (o.k === 'ask' && o.text) { const el = document.createElement('div'); el.className = 'line'; el.textContent = o.text; $('#asks').appendChild(el); }
  else if (o.k === 'next' && o.text) {
    const el = document.createElement('button'); el.className = 'line'; el.textContent = o.text;
    el.onclick = () => { addLine(o.text); el.remove(); renderCoach(); };
    $('#next').appendChild(el);
  } else if (o.k === 'score') {
    const cell = (n, l) => { const v = Math.max(0, Math.min(100, Math.round(Number(n) || 0))); return `<div class="score">${l}<b>${v}</b><div class="bar"><i style="width:${v}%"></i></div></div>`; };
    $('#scores').innerHTML = cell(o.specific, 'Specific') + cell(o.clear, 'Clear') + cell(o.structure, 'Structure'); $('#scores').hidden = false;
    $('#verdict').textContent = o.line || ''; $('#verdict').hidden = !o.line;
  }
  renderCoach();
}
function addLine(text) { const v = ta.value.replace(/\s+$/, ''); ta.value = v + (v ? ' ' : '') + text; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); onText(); }
function selectQuote(q) { const i = findQuote(ta.value, q); if (i < 0) return; ta.focus(); ta.setSelectionRange(i, i + q.length); moved(true); }
function applyFix(o) {
  const i = findQuote(ta.value, o.quote); if (i < 0) return;
  ta.value = ta.value.slice(0, i) + o.fix + ta.value.slice(i + o.quote.length);
  S.coach.tips = S.coach.tips.filter((t) => t !== o); S.coach.hot = null; ta.focus(); ta.setSelectionRange(i, i + o.fix.length); onText();
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
