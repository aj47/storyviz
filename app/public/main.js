import { Stage, STYLES, STYLE_ORDER, actKey } from './scene.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ta = $('#text');
const store = { get: (k) => localStorage.getItem('sv.' + k), set: (k, v) => localStorage.setItem('sv.' + k, v) };
const flag = (k, d) => { const v = store.get(k); return v == null ? d : v === '1'; };

const S = {
  packs: [], pack: null, project: null, projects: [],
  strict: !flag('fill', true), restyle: flag('restyle', true), live: flag('live', true), improve: flag('improve', true), styleIdx: 0,
  // What the AI may start on its own. Anything the writer asks for by hand always runs.
  auto: { draw: flag('autoDraw', true), motion: flag('autoMotion', true), facts: flag('autoFacts', true), blanks: flag('autoBlanks', true) }, paused: false, spent: new Map(),
  scenes: new Map(), seq: 0, cur: 0, shown: null, paras: [],
  coach: { seq: 0, shownSeq: 0, runs: new Map(), tips: [], good: [], hot: null, tab: 'tips', states: {}, saved: null, factRuns: [], factBusy: null, research: [], fills: { opts: new Map(), asked: new Set(), busy: null }, dismissed: new Set() },
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
  $('#restyleSw').checked = S.restyle; $('#improveSw').checked = S.improve; $('#fillSw').checked = !S.strict; $('#liveSw').checked = S.live;
  for (const [id, k] of AUTOS) $('#' + id).checked = S.auto[k];
  renderPause();
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
  for (const sc of S.scenes.values()) { sc.ctrl?.abort(); stopImproving(sc); }
  S.scenes.clear();
  for (const s of p.scenes || []) {
    const raw = (s.raw || []).filter((r) => parseLine(r)), lines = raw.map(parseLine); if (!lines.length) continue;
    S.scenes.set(s.key, { key: s.key, idx: s.idx, pack: p.pack, seq: ++S.seq, text: s.text, lines, raw, round: s.round || 0, guide: s.guide || '', caption: s.cap || undefined, motionTried: Boolean(s.mo), status: 'done', shot: lines.filter((o) => o.t === 'shot').pop() || null });
  }
  ta.value = p.text || ''; ta.setSelectionRange(0, 0); ta.scrollTop = 0;
  S.coach.dismissed = new Set(Array.isArray(p.dismissed) ? p.dismissed : []);
  applyPack(); restoreCoach(p.coach); restoreResearch(p.research); restoreFills(p.fills);
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
// Every save says why it happened. The server turns named changes into versions of their own in History.
let saveTimer = 0, dirty = false, saveChain = Promise.resolve(); const reasons = new Set();
const SAVE_LABEL = { saved: 'Saved', dirty: 'Save', saving: 'Saving…', error: 'Not saved. Retry' };
function setSaveState(state) { const b = $('#saveBtn'); b.textContent = SAVE_LABEL[state]; b.className = 'save ' + state; }
function markDirty(why = 'Edited') {
  if (!S.project) return;
  reasons.add(why); dirty = true; setSaveState('dirty');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 800);
}
function snapshot(p) {
  p.name = $('#name').value.trim() || 'Untitled'; p.text = ta.value; p.pack = S.pack.id; p.coach = S.coach.saved;
  p.research = S.coach.research.filter((r) => r.status === 'done').map(({ q, sources, lines, rewrote }) => ({ q, sources, lines, rewrote }));
  const f = S.coach.fills; p.fills = [...f.asked].filter((slot) => f.opts.get(slot)?.length).map((slot) => ({ slot, opts: f.opts.get(slot) }));
  const kept = new Map();
  S.paras.forEach((para, i) => {
    // While a paragraph's new drawing is still on its way, the drawing it has now is the one that is saved.
    let sc = S.scenes.get(keyOf(para.text));
    if (!(sc && sc.status === 'done' && sc.raw.length)) {
      sc = null;
      for (const x of S.scenes.values()) if (x.pack === S.pack.id && x.idx === i && x.status === 'done' && x.raw.length && (!sc || x.seq > sc.seq)) sc = x;
    }
    const key = sc?.key.replace(/\|old$/, '');
    if (sc && !kept.has(key)) kept.set(key, { key, idx: i, text: sc.text, raw: sc.raw, round: sc.round || 0, guide: sc.guide || '', cap: sc.caption || '', mo: sc.motionTried ? 1 : 0 });
  });
  p.dismissed = [...S.coach.dismissed].slice(-200);
  p.scenes = [...kept.values()];
}
// Saves are queued one after another, so a slow save can never overwrite a newer one.
function saveNow() {
  clearTimeout(saveTimer);
  const p = S.project; if (!p || !dirty) return saveChain;
  dirty = false; snapshot(p); setSaveState('saving');
  const why = [...reasons]; reasons.clear();
  const body = JSON.stringify({ ...p, why });
  saveChain = saveChain.then(async () => {
    try {
      const r = await api('PUT', '/api/projects/' + p.id, body); p.updatedAt = r.updatedAt;
      const row = S.projects.find((x) => x.id === p.id); if (row) Object.assign(row, { name: p.name, pack: p.pack, updatedAt: p.updatedAt, words: (p.text.match(/\S+/g) || []).length });
      if (S.project === p && !dirty) setSaveState('saved');
    } catch (e) {
      console.warn('save failed', e);
      why.forEach((w) => reasons.add(w));
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
$('#fillSw').onchange = (e) => { S.strict = !e.target.checked; store.set('fill', S.strict ? '0' : '1'); schedule(); };
$('#liveSw').onchange = (e) => {
  S.live = e.target.checked; store.set('live', S.live ? '1' : '0');
  clearTimeout(coachTimer); if (S.live) runCoach(); renderCoach();
};
$('#improveSw').onchange = (e) => { S.improve = e.target.checked; store.set('improve', S.improve ? '1' : '0'); if (!S.improve) stopImproving(); };
const AUTOS = [['autoDraw', 'draw'], ['autoMotion', 'motion'], ['autoFacts', 'facts'], ['autoBlanks', 'blanks']];
for (const [id, k] of AUTOS) $('#' + id).onchange = (e) => {
  S.auto[k] = e.target.checked; store.set(id, S.auto[k] ? '1' : '0');
  if (k === 'draw' && S.auto.draw) schedule(); if (k === 'blanks') { renderBlanks(true); if (S.auto.blanks) runFills(); }
  if (k === 'facts' && S.auto.facts) { if (S.live) runCoach(); else findClaims(); }
};
// Pause stops new automatic work from starting. Requests already sent keep going; Stop everything cancels those too.
function renderPause() {
  for (const id of ['pauseBtn', 'pauseBtn2']) $('#' + id).textContent = S.paused ? 'Resume' : id === 'pauseBtn' ? 'Pause' : 'Pause automatic work';
}
function setPaused(on) {
  S.paused = on; renderPause(); renderBlanks(true);
  if (on) stopImproving(); else { schedule(); if (S.live) runCoach(); runFills(); }
  renderQueue();
}
// Run now: each kind of work once, by hand, whatever its switch says. Scene work takes the typed direction along.
function runNow(kind, btn) {
  const c = S.coach, note = $('#steerText').value.trim().slice(0, 300), sc = sceneNow(), said = (t) => { const was = btn.textContent; btn.textContent = t; setTimeout(() => { btn.textContent = was; }, 1600); };
  const sceneJob = ['draw', 'motion', 'improve'].includes(kind);
  if (kind === 'draw') {
    if (note) { if ((S.paras[S.cur]?.text.length || 0) < 12) return said('No scene here'); guideScene(S.cur, note); }
    else if (!schedule(true)) return said('All drawn');
  } else if (kind === 'motion' || kind === 'improve') {
    if (!sc || sc.status !== 'done' || !sc.lines.length) return said('No drawing yet');
    if (S.pack.visual === 'diagram') return said('Not for diagrams');
    if (kind === 'motion') dropMotion(sc);
    if (kind === 'motion') { sc.wantMotion = true; sc.noteMotion = note; } else { sc.wantImprove = true; sc.noteImprove = note; }
    sc.impError = false;
    if (improving && improving !== sc) stopImproving();
  } else if (kind === 'review') { if (ta.value.trim().length < 3) return said('Nothing to read'); runCoach(true); }
  else if (kind === 'facts') {
    if (ta.value.trim().length < 3) return said('Nothing to check');
    // Claims come out of a review, so a draft that changed since its last review is reviewed first.
    if (c.lastRun && c.lastRun.text === ta.value && !c.factBusy) checkFacts(c.lastRun, true); else { c.factsNext = true; runCoach(true); }
  } else if (kind === 'blanks') { if (!blanksIn(ta.value).some((x) => !STAGE_DIR.test(x))) return said('No blanks'); runFills(true); }
  if (sceneJob && note) $('#steerText').value = '';
  said('Sent'); renderPages(); renderQueue();
}
$('.autos').addEventListener('click', (e) => { const b = e.target.closest('button[data-run]'); if (b) runNow(b.dataset.run, b); });
function steer(to) {
  const box = $('#steerText'), text = box.value.trim(); if (text.length < 3) { box.focus(); return; }
  if (to === 'scene') { if ((S.paras[S.cur]?.text.length || 0) < 12) return; guideScene(S.cur, text); setTab('activity'); }
  else { setTab('research'); ask(text); }
  box.value = ''; renderQueue();
}
$('#steerForm').addEventListener('click', (e) => { const b = e.target.closest('button[data-to]'); if (b) { e.preventDefault(); steer(b.dataset.to); } });
$('#steerForm').addEventListener('submit', (e) => { e.preventDefault(); steer('script'); });
$('#steerText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); steer(e.metaKey || e.ctrlKey ? 'scene' : 'script'); } });
$('#pauseBtn').onclick = $('#pauseBtn2').onclick = () => setPaused(!S.paused);
$('#stopAllBtn').onclick = () => {
  setPaused(true); const c = S.coach;
  for (const sc of [...S.scenes.values()]) { if (flying(sc)) { sc.ctrl.abort(); S.scenes.delete(sc.key); } stopImproving(sc); }
  c.runs.forEach((r) => r.ctrl.abort()); c.runs.clear(); c.factBusy?.abort(); c.factBusy = null; c.claimsRun?.ctrl.abort(); c.claimsRun = null;
  if (c.fills.busy) { c.fills.busy.abort(); c.fills.busy = null; }
  c.research = c.research.filter((r) => { const busy = ['search', 'wait', 'gen'].includes(r.status); if (busy) r.ctrl.abort(); return !busy; });
  renderResearch(); renderBlanks(true); renderPages(); showCurrent(); renderCoach(); renderQueue();
};
$('#reviewBtn').onclick = () => runCoach(true);
$('#redrawBtn').onclick = () => redraw();
$('#sampleBtn').onclick = () => { ta.value = S.pack.placeholder || ''; ta.focus(); ta.setSelectionRange(0, 0); onText(true); };

// ---------- editor ----------
let sceneTimer = 0, coachTimer = 0, fillTimer = 0;
const SCENE_PAUSE = 2500, COACH_PAUSE = 4000, IMPROVE_PAUSE = 6000;
function onText(immediate = false, changed = true) {
  S.paras = paragraphs(ta.value); syncCurrent(); renderStats(); renderBackdrop(); renderPages();
  $('#sampleBtn').hidden = ta.value.length > 0 || !S.pack?.placeholder;
  S.coach.tips.forEach((t) => tipEls.get(t)?.classList.toggle('stale', findQuote(ta.value, t.quote) < 0));
  if (changed) markDirty();
  // Every request waits about a minute in the queue, so nothing is sent until the writer has really paused:
  // a request for a half-typed sentence would be stale before it started, and its replacement queues again.
  clearTimeout(sceneTimer); sceneTimer = setTimeout(schedule, immediate ? 50 : SCENE_PAUSE);
  clearTimeout(coachTimer); if (S.live) coachTimer = setTimeout(runCoach, immediate ? 200 : COACH_PAUSE);
  else if (S.auto.facts && changed) coachTimer = setTimeout(findClaims, COACH_PAUSE);
  clearTimeout(fillTimer); fillTimer = setTimeout(runFills, immediate ? 400 : COACH_PAUSE);
  renderBlanks(); renderCoach();
}
function moved(force = false) { if (syncCurrent() || force) { renderBackdrop(); renderPages(); showCurrent(); } }
let lastEdit = -1e9;
ta.addEventListener('input', () => { lastEdit = performance.now(); onText(); });
ta.addEventListener('scroll', () => { $('#backdrop').scrollTop = ta.scrollTop; });
for (const ev of ['keyup', 'click', 'focus']) ta.addEventListener(ev, () => moved());
// A click inside a blank selects all of it, so typing replaces it, and brings up its suggestions.
ta.addEventListener('click', () => {
  const pos = ta.selectionStart; if (pos !== ta.selectionEnd) return;
  for (const m of ta.value.matchAll(BLANK)) {
    if (pos <= m.index || pos >= m.index + m[0].length) continue;
    ta.setSelectionRange(m.index, m.index + m[0].length); setTab('tips');
    const el = $$('#blanks .blank').find((x) => x.dataset.slot === m[0]); if (!el) return;
    el.scrollIntoView({ block: 'nearest' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900);
  }
});

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
  for (const m of text.matchAll(BLANK)) marks.push({ a: m.index, b: m.index + m[0].length, cls: 'slot' + (c.hotSlot === m[0] ? ' hot' : '') });
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

function schedule(force = false) {
  if (!S.pack) return 0;
  const order = [S.cur, ...S.paras.map((_, i) => i).filter((i) => i !== S.cur)];
  const wanted = new Set(S.paras.map((p) => keyOf(p.text)));
  // A request already in the queue is never cancelled because its paragraph was edited. It lands, and the
  // edit then goes out as an update to that drawing, so the minute it has waited is not thrown away.
  // Only a request whose paragraph is gone (deleted or rewritten from scratch) is dropped.
  const busy = new Set();
  for (const sc of [...S.scenes.values()]) {
    if (!flying(sc) || wanted.has(sc.key) || sc.key.endsWith('|old')) continue;
    const i = laterVersion(sc);
    if (i < 0) { sc.ctrl.abort(); S.scenes.delete(sc.key); } else { busy.add(i); sc.idx = i; }
  }
  if (improving && !wanted.has(improving.key)) stopImproving();
  let live = [...S.scenes.values()].filter(flying).length;
  let started = 0;
  for (const i of force !== true && (S.paused || !S.auto.draw) ? [] : order) {
    const p = S.paras[i]; if (!p || p.text.length < 12) continue;
    const key = keyOf(p.text); if (S.scenes.has(key) || busy.has(i)) continue;
    if (live >= 5) break;
    startScene(i, p.text, key); live++; started++;
  }
  renderPages(); showCurrent();
  return started;
}

// How much two texts are the same paragraph: the share of the shorter one's words found in the other,
// so adding or cutting a sentence still counts as the same paragraph.
const wordsOf = (t) => new Set(t.toLowerCase().match(/[a-z0-9']+/g) || []);
function alike(a, b) {
  const x = wordsOf(a), y = wordsOf(b), small = Math.min(x.size, y.size); if (small < 3) return 0;
  let same = 0; for (const w of x) if (y.has(w)) same++;
  return same / small;
}
// The paragraph on the page that an in-flight request was an earlier wording of, or -1 when there is none.
function laterVersion(sc) {
  let best = -1, top = 0;
  S.paras.forEach((p, i) => {
    if (p.text.length < 12 || S.scenes.has(keyOf(p.text))) return;
    const score = alike(sc.text, p.text) + (i === sc.idx ? 0.001 : 0);
    if (score >= 0.6 && score > top) { best = i; top = score; }
  });
  return best;
}

// The drawing an edited paragraph had before the edit: the closest earlier text of this writing type.
function earlierVersion(text, wanted) {
  let best = null, top = 0;
  for (const sc of S.scenes.values()) {
    // Same writing type and same Fill gaps setting only, and never the identical text: that would be a redraw, not an edit.
    if (!sc.key.startsWith(`${S.pack.id}|${S.strict ? 1 : 0}|`) || sc.text === text || sc.status !== 'done' || !sc.lines.length || wanted.has(sc.key) || sc.key.endsWith('|old')) continue;
    const score = alike(text, sc.text);
    if (score >= 0.6 && (score > top || (score === top && sc.seq > best.seq))) { best = sc; top = score; }
  }
  return best;
}

// One place where a line from Kimi changes a scene, whether it is a first drawing, an update or an improvement.
function applyLine(sc, o) {
  const shown = S.shown === sc;
  if (o.t === 'reset') { sc.lines = []; sc.raw = []; sc.shot = null; sc.round = 0; if (shown) { stage.clear(); $('#title').textContent = ''; showShot(null); } return; }
  if (o.t === 'drop') {
    const id = String(o.id), keep = sc.lines.map((l) => !((l.t === 'obj' && String(l.id) === id) || (l.t === 'many' && String(l.of) === id) || (l.t === 'act' && [l.id, l.of, l.from, l.to].includes(id))));
    sc.lines = sc.lines.filter((_, i) => keep[i]); sc.raw = sc.raw.filter((_, i) => keep[i]);
    if (shown) stage.drop(id);
    return;
  }
  let at = -1;
  if (o.t === 'obj' && o.id != null) at = sc.lines.findIndex((l) => l.t === 'obj' && String(l.id) === String(o.id));
  else if (o.t === 'env' || o.t === 'shot') at = sc.lines.findIndex((l) => l.t === o.t);
  else if (o.t === 'act' || o.t === 'count') at = sc.lines.findIndex((l) => l.t === o.t && actKey(l) === actKey(o));
  if (o.t === 'env' && at >= 0) o = { ...sc.lines[at], ...o };
  const raw = JSON.stringify(o);
  if (at >= 0) { sc.lines[at] = o; sc.raw[at] = raw; } else { sc.lines.push(o); sc.raw.push(raw); }
  if (o.t === 'shot') sc.shot = o;
  if (shown) stage.upsert(o, true); else if (sceneFor(S.cur) === sc) showCurrent();
}

async function startScene(idx, text, key, { fresh = false, guide, from = null, caption } = {}) {
  const sc = { key, idx, pack: S.pack.id, seq: ++S.seq, text, lines: [], raw: [], status: 'wait', t0: performance.now(), waitMs: 0, genStart: 0, chars: 0, ctrl: new AbortController(), shot: null };
  // An edit keeps the drawing it had: the scene starts as a copy and Kimi sends only what changes.
  const base = from || (fresh ? null : earlierVersion(text, new Set(S.paras.map((p) => keyOf(p.text)))));
  // A direction from the writer stays with the paragraph through later edits.
  sc.guide = guide ?? base?.guide ?? ''; sc.updating = Boolean(base);
  // So does the on-screen text the writer set by hand.
  sc.caption = caption ?? base?.caption;
  if (base) {
    Object.assign(sc, { lines: base.lines.slice(), raw: base.raw.slice(), shot: base.shot, round: Math.min(base.round || 0, PLAN.length - 1), motionTried: base.motionTried });
    stopImproving(base);
    if (S.shown === base) S.shown = sc;
  }
  S.scenes.set(key, sc);
  const prev = idx > 0 ? sceneFor(idx - 1) : null;
  const body = {
    mode: S.pack.visual, style: STYLE_ORDER[S.styleIdx], strict: S.strict, kind: S.pack.name, index: idx, total: S.paras.length,
    context: S.paras.slice(0, idx).map((p) => p.text).join('\n\n'),
    cast: prev && !base ? prev.raw.filter((r) => r.includes('"t":"obj"') && !r.includes('"ghost":true')).slice(0, 5).join('\n') : '',
    paragraph: text, fresh, guide: sc.guide, caption: sc.caption || '',
    ...(base ? { update: true, before: base.text, scene: base.raw.join('\n') } : {}),
  };
  try {
    await sse('/api/scene', body, sc.ctrl.signal, (ev) => {
      if (ev.type === 'wait') sc.waitMs = ev.ms;
      else if (ev.type === 'prompt') sc.prompt = ev.text;
      else if (ev.type === 'first') { sc.status = 'gen'; sc.waitMs = ev.waitMs; sc.genStart = performance.now(); sc.cached = Boolean(ev.cached); }
      else if (ev.type === 'line') {
        const o = parseLine(ev.raw); if (!o) return;
        if ((o.t === 'reset' || o.t === 'drop') && !base) return;
        sc.chars += ev.raw.length; applyLine(sc, o); renderPages();
      } else if (ev.type === 'done') { sc.status = 'done'; sc.done = ev; }
      else if (ev.type === 'error') { sc.status = 'error'; sc.error = ev.message; }
    });
    if (sc.status !== 'done' && sc.status !== 'error') sc.status = sc.lines.length ? 'done' : 'error';
  } catch (e) { if (sc.ctrl.signal.aborted) return; sc.status = 'error'; sc.error = String(e.message || e); }
  if (sc.status === 'done') {
    for (const [k, v] of S.scenes) if (k.endsWith('|old') && v.idx === idx) S.scenes.delete(k);
    markDirty(`Scene ${idx + 1} ${base ? (guide ? 'guided' : 'updated') : fresh ? 'redrawn' : 'drawn'}`);
  }
  renderPages();
  // Mid-typing, the pause timer sends the follow-up; otherwise the edit made during the wait goes out now.
  if (performance.now() - lastEdit >= SCENE_PAUSE) schedule();
}

// Draws the current scene again. The old drawing stays on screen until the new one starts arriving.
function redraw() {
  const p = S.paras[S.cur]; if (!p || p.text.length < 12) return;
  const key = keyOf(p.text); let old = S.scenes.get(key);
  if (old && flying(old)) return;
  if (old?.status === 'cancelled' && !old.lines.length) old = null;
  stopImproving(old);
  if (old) { S.scenes.delete(key); if (old.lines.length) { old.key = key + '|old'; S.scenes.set(old.key, old); } }
  startScene(S.cur, p.text, key, { fresh: true, guide: old?.guide, caption: old?.caption }); renderPages();
}

// ---------- guide ----------
// The writer tells the illustrator what to change. A request still in the queue for this paragraph is
// replaced, because the direction changes what it should draw; a finished drawing is updated in place.
function guideScene(idx, guide, caption) {
  const p = S.paras[idx]; if (!p || p.text.length < 12) return;
  const key = keyOf(p.text), wanted = new Set(S.paras.map((x) => keyOf(x.text)));
  for (const sc of [...S.scenes.values()]) if (flying(sc) && (sc.key === key || (sc.idx === idx && !wanted.has(sc.key)))) { sc.ctrl.abort(); S.scenes.delete(sc.key); }
  const old = S.scenes.get(key); let from = null;
  if (old) {
    stopImproving(old); S.scenes.delete(key);
    if (old.lines.length) { old.key = key + '|old'; S.scenes.set(old.key, old); from = old; }
  }
  startScene(idx, p.text, key, { guide: guide.trim().slice(0, 300), from, caption: caption ?? old?.caption }); renderPages();
}

// ---------- scene inspector ----------
// The strip under the stage holds everything about how the current scene looks: the words on screen, the
// direction given to the illustrator, and the motion. None of it is part of the script.
const sceneNow = () => activeFor(S.cur) || sceneFor(S.cur);
// Only the opening scene carries on-screen text by default (the text hook). Any other scene shows text only if the writer typed some.
const captionOf = (sc) => (sc ? sc.caption ?? (sc.idx === 0 ? sc.shot?.text : '') ?? '' : '');
function setCaption(idx, text) {
  const sc = activeFor(idx) || sceneFor(idx); if (!sc) return;
  sc.caption = text.trim().slice(0, 60) || undefined;
  if (S.shown === sc) showShot(sc.shot);
  markDirty(`Scene ${idx + 1} on-screen text`); inspSig = ''; renderInspector();
}
const who = (ref) => (Array.isArray(ref) ? 'a point' : String(ref ?? '').replace(/^(subject|setting|background|polish|motion)_/, '').replace(/_/g, ' '));
function motionWords(o) {
  if (o.t === 'count') return `counts ${o.from ?? 0} to ${Number(o.to).toLocaleString()}${o.text ? ' ' + String(o.text).replace('{n}', '').trim() : ''}`;
  if (o.t === 'obj') return `${who(o.id)} ${o.in === 'drop' ? 'drops in' : o.in === 'grow' ? 'grows up' : o.in === 'left' || o.in === 'right' ? 'slides in' : 'appears'}`;
  const id = who(o.id);
  return { move: `${id} goes to ${who(o.to)}`, flow: `${o.of ? who(o.of) + 's' : 'dots'} flow from ${who(o.from)} to ${who(o.to)}`, grow: `${id} ${Number(o.k) < 1 ? 'shrinks' : 'grows'}`,
    rise: `${id} rises`, shake: `${id} shakes`, vanish: `${id} vanishes`, spin: `${id} spins`, flash: `${id} is highlighted`, look: `camera on ${id}` }[o.do] || o.do;
}
let inspSig = '';
function renderInspector() {
  const sc = sceneNow(), mode = S.pack?.visual, drawable = (S.paras[S.cur]?.text.length || 0) >= 12;
  $('#capRow').hidden = mode !== 'storyboard'; $('#motionRow').hidden = mode === 'diagram';
  const cap = $('#capInput'), dir = $('#dirInput');
  cap.disabled = !sc; dir.disabled = !drawable; $('#dirBtn').disabled = !drawable;
  $('#animateBtn').disabled = !sc || sc.status !== 'done' || Boolean(sc.wantMotion) || Boolean(sc.imps);
  const moves = sc ? sc.lines.filter((l) => l.t === 'act' || l.t === 'count' || (l.t === 'obj' && l.step)) : [];
  const sig = [S.cur, sc?.key, sc?.caption, sc?.shot?.text, sc?.guide, moves.map((l) => (l.t === 'obj' ? l.id : actKey(l))).join(','), sc?.imps?.some((i) => i.focus === 'motion') || sc?.wantMotion ? 1 : 0].join('|');
  if (sig === inspSig) return; inspSig = sig;
  if (document.activeElement !== cap) { cap.value = captionOf(sc); cap.placeholder = sc?.idx === 0 ? 'The text hook shown on screen' : 'None. Type here to put words on screen in this scene'; }
  if (document.activeElement !== dir) dir.value = sc?.guide || '';
  const busy = sc?.wantMotion || sc?.imps?.some((i) => i.focus === 'motion');
  $('#motion').innerHTML = moves.sort((a, b) => (a.step || 0) - (b.step || 0)).map((l) => `<span class="chip"><b>${Number(l.step) || 1}</b>${esc(motionWords(l))}`
    + (l.t === 'obj' ? '' : `<button data-key="${esc(actKey(l))}" title="Remove this motion">×</button>`) + '</span>').join('')
    || `<span class="none">${busy ? 'Motion is on its way.' : sc ? 'Nothing moves yet.' : ''}</span>`;
}
$('#capInput').addEventListener('change', () => setCaption(S.cur, $('#capInput').value));
$('#capInput').addEventListener('input', () => { const sc = sceneNow(); if (sc && S.shown === sc) $('#caption').textContent = $('#capInput').value; });
$('#capInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('#dirForm').addEventListener('submit', (e) => { e.preventDefault(); guideScene(S.cur, $('#dirInput').value); $('#dirInput').blur(); });
$('#motion').addEventListener('click', (e) => {
  const key = e.target.closest('button')?.dataset.key, sc = sceneNow(); if (!key || !sc) return;
  const keep = sc.lines.map((l) => !((l.t === 'act' || l.t === 'count') && actKey(l) === key));
  sc.lines = sc.lines.filter((_, i) => keep[i]); sc.raw = sc.raw.filter((_, i) => keep[i]);
  if (S.shown === sc) stage.dropAct(key);
  markDirty(`Scene ${S.cur + 1} motion removed`); renderInspector();
});
// Re-animate throws the scene's motion away and asks for it again. It jumps the line of automatic work.
function dropMotion(sc) {
  const keep = sc.lines.map((l) => l.t !== 'act' && l.t !== 'count');
  sc.lines.forEach((l, i) => { if (!keep[i] && S.shown === sc) stage.dropAct(actKey(l)); });
  sc.lines = sc.lines.filter((_, i) => keep[i]); sc.raw = sc.raw.filter((_, i) => keep[i]);
}
$('#animateBtn').onclick = () => {
  const sc = sceneNow(); if (!sc || sc.status !== 'done') return;
  dropMotion(sc); sc.wantMotion = true; sc.noteMotion = $('#dirInput').value.trim(); sc.impError = false; if (improving && improving !== sc) stopImproving();
  renderInspector();
};

// ---------- queue ----------
// Everything that is waiting for the model, with the prompt that was sent, and a way to cancel it,
// resend it with the current text, or resend a drawing with a direction.
let qSeq = 0, queueSig = ''; const qIds = new WeakMap();
const qId = (o) => { if (!qIds.has(o)) qIds.set(o, ++qSeq); return qIds.get(o); };
// When nothing is in the queue, the header says why, so a quiet moment never looks like a stall.
function idleWhy() {
  if (performance.now() - lastEdit < IMPROVE_PAUSE) return 'Waiting for you to pause';
  if (document.hidden) return 'Resting while this tab is hidden';
  if (!S.improve) return 'All caught up. Improve looks is off';
  return 'About to refine the next scene';
}
// Where each kind of work stands, in a line under its switch: a switch that is on with nothing left to do says so.
function workStatus() {
  const c = S.coach, n = S.paras.filter((p) => p.text.length >= 12).length, plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const scs = S.paras.map((_, i) => activeFor(i)).filter((sc) => sc && sc.status === 'done' && sc.lines.length);
  const moving = scs.filter((sc) => sc.lines.some((l) => l.t === 'act' || l.t === 'count')).length, full = scs.filter((sc) => (sc.round || 0) >= PLAN.length).length;
  const slots = blanksIn(ta.value).filter((x) => !STAGE_DIR.test(x)), filled = slots.filter((x) => (c.fills.opts.get(x) || []).some((o) => o.text)).length;
  const reviewed = c.saved && c.saved.text === ta.value, claims = c.factRuns.reduce((k, fr) => k + fr.quotes.length, 0);
  const diagram = S.pack?.visual === 'diagram';
  return {
    draw: n ? (scs.length >= n ? `All ${plural(n, 'scene')} drawn` : `${scs.length} of ${plural(n, 'scene')} drawn`) : 'Nothing to draw yet',
    motion: diagram ? 'Diagrams move on their own' : !scs.length ? 'Needs a drawing first' : moving >= scs.length ? 'Every scene has motion. It runs once per scene; Run now redoes this one' : `${moving} of ${plural(scs.length, 'scene')} have motion`,
    improve: diagram ? 'Not used for diagrams' : !scs.length ? 'Needs a drawing first' : S.improve ? (full >= scs.length ? 'Refining the scenes in turn, without stopping' : `${full} of ${plural(scs.length, 'scene')} through their first passes`) : `Off. ${full} of ${plural(scs.length, 'scene')} through their first passes`,
    review: ta.value.trim().length < 3 ? 'Nothing to read yet' : reviewed ? 'This draft is reviewed. Runs again when the words change' : 'The draft changed since the last review',
    facts: c.factBusy ? 'Checking now' : c.claimsRun ? 'Finding the claims to check' : `${plural(claims, 'claim')} checked. Runs again when the words change`,
    blanks: slots.length ? `${filled} of ${plural(slots.length, 'blank')} have suggestions` : 'No blanks in the draft',
  };
}
const mins = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
function queueItems() {
  const c = S.coach, items = [], wanted = new Set(S.paras.map((p) => keyOf(p.text)));
  for (const sc of S.scenes.values()) {
    if (flying(sc)) { const stale = !wanted.has(sc.key); items.push({ o: sc, kind: 'scene', title: `Scene ${sc.idx + 1}`, sub: [sc.updating ? 'update' : 'new drawing', stale ? 'older wording' : '', sc.guide ? 'guided' : ''].filter(Boolean).join(' · '), text: sc.text, stale }); }
    for (const imp of sc.imps || []) if (imp.status !== 'over') items.push({ o: imp, kind: 'improve', sc, title: `Scene ${sc.idx + 1}`, sub: imp.focus === 'motion' ? 'adding motion' : imp.focus === 'refine' ? 'refining' : `improving ${imp.focus}`, text: sc.text });
  }
  for (const r of c.runs.values()) { const stale = r.text !== ta.value; items.push({ o: r, kind: 'coach', title: 'Review', sub: stale ? 'older draft' : '', text: r.text, stale }); }
  if (c.claimsRun) items.push({ o: c.claimsRun, kind: 'claims', title: 'Fact check', sub: 'finding the claims', text: c.claimsRun.text });
  if (c.factBusy) items.push({ o: c.factBusy, kind: 'facts', title: 'Fact check', sub: '', text: c.factBusy.quotes.join(' · ') });
  for (const r of c.research) if (['search', 'wait', 'gen'].includes(r.status)) items.push({ o: r, kind: 'research', title: 'Agent', sub: '', text: r.q });
  if (c.fills.busy) items.push({ o: c.fills.busy, kind: 'fills', title: 'Blank suggestions', sub: '', text: c.fills.busy.slots.join(' · ') });
  return items;
}
function renderQueue() {
  const items = queueItems(), box = $('#queue');
  // The header always says what is being worked on right now, and for how long.
  const top = items.find((it) => it.o.status === 'gen') || items.slice().sort((a, b) => (a.o.t0 || 0) - (b.o.t0 || 0))[0];
  const pill = $('#queueBtn'); pill.className = 'activity ' + (S.paused && !top ? 'paused' : top ? (top.o.status === 'gen' ? 'gen' : 'wait') : '');
  const words = top ? `${top.title}${top.sub ? ' · ' + top.sub : ''} · ${top.o.status === 'gen' ? 'answering' : top.o.status === 'search' ? 'searching' : Math.round((performance.now() - top.o.t0) / 1000) + 's in queue'}` : S.paused ? 'Paused' : idleWhy();
  pill.innerHTML = `<b class="lamp"></b><span>${esc(words)}</span>${items.length > 1 ? `<i>+${items.length - 1}</i>` : ''}`;
  $('#activityCount').textContent = items.length || '';
  if (S.coach.tab !== 'activity') { queueSig = ''; return; }
  for (const [k, text] of Object.entries(workStatus())) $('#st-' + k).textContent = text;
  $('#spent').innerHTML = [...S.spent].map(([kind, v]) => `<div><b>${esc(kind)}</b><span>${v.n} request${v.n === 1 ? '' : 's'}</span><span>${mins(v.wait)} in queue</span><span>${mins(v.gen)} answering</span>${v.stopped ? `<span>${v.stopped} stopped</span>` : ''}</div>`).join('') || 'No requests yet.';
  $('#queueEmpty').hidden = items.length > 0;
  const sig = items.map((it) => `${qId(it.o)}${it.o.status === 'gen' ? 'g' : 'w'}${it.stale ? 's' : ''}${it.o.prompt ? 'p' : ''}`).join(',');
  if (sig !== queueSig) {
    queueSig = sig;
    // Rebuilding must not lose a direction that is being typed or close an open prompt.
    const typed = new Map([...box.querySelectorAll('input')].map((el) => [el.closest('.q').dataset.id, el.value]));
    const open = new Set([...box.querySelectorAll('details[open]')].map((el) => el.closest('.q').dataset.id));
    const focus = document.activeElement?.closest?.('#queue .q')?.dataset.id;
    box.innerHTML = items.map((it) => {
      const id = String(qId(it.o));
      return `<div class="q" data-id="${id}"><div class="q-head"><b>${esc(it.title)}</b><span>${esc(it.sub)}</span><span class="q-time"></span></div>`
        + `<div class="q-text">${esc(it.text)}</div>`
        + (it.o.prompt ? `<details${open.has(id) ? ' open' : ''}><summary>Prompt sent (${it.o.prompt.length.toLocaleString()} characters)</summary><pre>${esc(it.o.prompt)}</pre></details>` : '')
        + '<form class="q-acts">'
        + (it.kind === 'scene' ? `<input class="field" maxlength="300" placeholder="Add a direction, e.g. set it at night" value="${esc(typed.get(id) || '')}"><button class="mini" data-act="guide">Resend</button>` : '<span class="gap"></span>')
        + (it.stale ? '<button class="mini" data-act="refresh" type="button" title="Drop this request and send the text as it is now">Send current text</button>' : '')
        + '<button class="mini bad" data-act="cancel" type="button">Cancel</button></form></div>';
    }).join('');
    if (focus) box.querySelector(`.q[data-id="${focus}"] input`)?.focus();
  }
  for (const it of items) {
    const el = box.querySelector(`.q[data-id="${qId(it.o)}"] .q-time`); if (!el) continue;
    const gen = it.o.status === 'gen'; el.classList.toggle('gen', gen);
    el.textContent = gen ? 'answering now' : it.o.status === 'search' ? 'searching the web' : `in queue ${Math.round((performance.now() - it.o.t0) / 1000)}s`;
  }
}
function queueAct(id, act, guide = '') {
  const it = queueItems().find((x) => String(qId(x.o)) === id); if (!it) return;
  const c = S.coach, o = it.o;
  if (it.kind === 'scene') {
    if (act === 'guide') { if (guide.trim()) guideScene(S.paras.some((p) => keyOf(p.text) === o.key) ? S.paras.findIndex((p) => keyOf(p.text) === o.key) : o.idx, guide); }
    else {
      o.ctrl.abort();
      // A cancelled request for the text on the page stays cancelled until Redraw; an older wording is simply dropped.
      if (act === 'cancel' && !it.stale) o.status = 'cancelled'; else S.scenes.delete(o.key);
      if (act === 'refresh') schedule();
    }
    renderPages(); showCurrent();
  } else if (it.kind === 'improve') { it.sc.round = PLAN.length; stopImproving(it.sc); markDirty(); }
  else if (it.kind === 'coach') { o.ctrl.abort(); c.runs.delete(o.seq); if (act === 'refresh') runCoach(true); renderCoach(); }
  else if (it.kind === 'facts') { o.abort(); c.factBusy = null; }
  else if (it.kind === 'claims') { o.ctrl.abort(); c.claimsRun = null; c.claimsText = o.text; }
  else if (it.kind === 'fills') { o.abort(); c.fills.busy = null; o.slots.forEach((s) => c.fills.asked.add(s)); renderBlanks(true); }
  else if (it.kind === 'research') { o.ctrl.abort(); c.research = c.research.filter((r) => r !== o); renderResearch(); }
  renderQueue();
}
$('#queueBtn').onclick = () => setTab('activity');
$('#queue').addEventListener('click', (e) => { const b = e.target.closest('button[type="button"][data-act]'); if (b) queueAct(b.closest('.q').dataset.id, b.dataset.act); });
$('#queue').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.closest('.q'); queueAct(q.dataset.id, 'guide', q.querySelector('input')?.value || ''); });

// ---------- keep improving ----------
// With the switch on, each finished scene goes back to Kimi in rounds. Round one sends three requests
// at once, each with its own focus, so the wait in the queue is paid once; the later rounds polish.
const PLAN = [['subject', 'setting', 'background'], ['polish'], ['polish'], ['polish']];
// Once the first round has filled the scene in, one pass choreographs it: what moves, in what order, to tell the paragraph.
// A scene that was drawn with motion already has it; this is for scenes that came out still.
const needsMotion = (sc) => ((sc.round || 0) >= 1 || !S.improve) && !sc.motionTried && !sc.lines.some((l) => l.t === 'act' || l.step);
let improving = null;
const stopImproving = (sc = improving) => sc?.imps?.forEach((i) => i.ctrl.abort());
function nextToImprove() {
  if (improving || !S.pack || S.pack.visual === 'diagram') return null;
  // Motion the writer asked for goes first, whatever the switches say.
  const asap = [...S.scenes.values()].find((sc) => (sc.wantMotion || sc.wantImprove) && sc.status === 'done' && sc.lines.length);
  if (asap) return asap;
  if (S.paused || (!S.improve && !S.auto.motion) || document.hidden) return null;
  // Improvement passes share the queue with everything else, so they wait until nothing the writer asked for is in it.
  const asked = S.coach.runs.size || S.coach.factBusy || S.coach.fills.busy || S.coach.research.some((r) => r.status === 'search' || r.status === 'wait');
  if (performance.now() - lastEdit < IMPROVE_PAUSE || asked || [...S.scenes.values()].some(flying)) return null;
  const order = [S.cur, ...S.paras.map((_, i) => i).filter((i) => i !== S.cur)];
  const ready = order.map((i) => activeFor(i)).filter((sc) => sc && sc.status === 'done' && sc.lines.length && !sc.impError);
  const first = ready.find((sc) => (S.improve && (sc.round || 0) < PLAN.length) || (S.auto.motion && needsMotion(sc)));
  if (first || !S.improve) return first || null;
  // Every scene has had its passes. Improving never stops: it goes round the scenes, the one on screen first,
  // refining whichever has had the fewest turns.
  return ready.slice().sort((a, b) => (a.refined || 0) - (b.refined || 0))[0] || null;
}
async function improveRound(sc) {
  improving = sc; sc.imps = [];
  const round = sc.round || 0, motion = sc.wantMotion || (!sc.wantImprove && S.auto.motion && needsMotion(sc));
  // Two things asked for by hand on one scene run one after the other, each with its own direction.
  const note = (motion ? sc.noteMotion : sc.noteImprove) || '';
  if (motion) { sc.wantMotion = false; sc.noteMotion = ''; } else { sc.wantImprove = false; sc.noteImprove = ''; }
  const refine = !motion && round >= PLAN.length;
  const results = await Promise.all((motion ? ['motion'] : refine ? ['refine'] : PLAN[round]).map((focus) => improveOnce(sc, focus, note)));
  sc.imps = null; improving = null;
  if (results.includes('aborted')) return;
  if (results.every((r) => r === 'error')) sc.impError = true;
  else if (refine) { sc.refined = (sc.refined || 0) + 1; inspSig = ''; if (results[0] > 0) markDirty(`Scene ${sc.idx + 1} refined`); }
  else if (motion) { sc.motionTried = true; inspSig = ''; markDirty(results[0] > 0 ? `Scene ${sc.idx + 1} animated` : 'Edited'); }
  // A round that changed nothing means Kimi has nothing left to add.
  else { const added = results.some((r) => r > 0); sc.round = added ? round + 1 : PLAN.length; markDirty(added ? `Scene ${sc.idx + 1} improved (${PLAN[round].join(', ')})` : 'Edited'); }
  renderPages();
}
async function improveOnce(sc, focus, note = '') {
  const imp = { focus, status: 'wait', t0: performance.now(), genStart: 0, chars: 0, n: 0, ctrl: new AbortController() };
  sc.imps.push(imp);
  const idx = Math.max(0, S.paras.findIndex((p) => keyOf(p.text) === sc.key)); let ok = false;
  // Passes run side by side, so a new object gets its focus as a prefix and two passes can never claim one id.
  const had = new Set(sc.lines.filter((l) => l.t === 'obj' && l.id != null).map((l) => String(l.id))), renamed = new Map();
  const body = {
    mode: S.pack.visual, strict: S.strict, kind: S.pack.name, index: idx, total: S.paras.length,
    context: S.paras.slice(0, idx).map((p) => p.text).join('\n\n'), paragraph: sc.text,
    // A refining pass must be a new answer each time; a replay from the cache would change nothing.
    improve: true, focus, fresh: focus === 'refine' || Boolean(note), guide: note, scene: sc.raw.join('\n'),
  };
  try {
    await sse('/api/scene', body, imp.ctrl.signal, (ev) => {
      if (ev.type === 'prompt') imp.prompt = ev.text;
      else if (ev.type === 'first') { imp.status = 'gen'; imp.genStart = performance.now(); imp.cached = Boolean(ev.cached); }
      else if (ev.type === 'line') {
        const o = parseLine(ev.raw); if (!o || !(focus === 'motion' ? ['obj', 'act', 'count'] : focus === 'refine' ? ['obj', 'act', 'count', 'drop'] : ['obj', 'many', 'env']).includes(o.t)) return;
        // Refining may redraw what is there, never add: the scene must not grow without end.
        if (focus === 'refine' && o.t === 'obj' && !had.has(String(o.id))) return;
        if (o.t === 'act') for (const f of ['id', 'of', 'from', 'to']) if (renamed.has(String(o[f]))) o[f] = renamed.get(String(o[f]));
        if (o.t === 'env') { if (focus !== 'setting') return; delete o.title; }
        else if (o.t === 'obj' && o.id != null && !had.has(String(o.id))) { const id = `${focus}_${o.id}`; renamed.set(String(o.id), id); o.id = id; }
        else if (o.t === 'many' && renamed.has(String(o.of))) o.of = renamed.get(String(o.of));
        imp.chars += ev.raw.length; imp.n++; applyLine(sc, o);
      } else if (ev.type === 'done') { ok = true; if (!ev.cached) { sc.done = ev; sc.cached = false; } }
    });
  } catch { /* aborted or failed */ }
  imp.status = 'over';
  return imp.ctrl.signal.aborted ? 'aborted' : ok ? imp.n : 'error';
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
  $('#caption').textContent = captionOf(S.shown);
}

function renderPages() {
  let total = 0;
  const html = S.paras.map((p, i) => {
    const sc = sceneFor(i), act = activeFor(i); const shot = sc?.shot; if (shot?.sec) total += Number(shot.sec) || 0;
    const label = shot && i === S.cur ? `${i + 1} · ${esc(shot.beat || 'beat')}${shot.sec ? ' ' + shot.sec + 's' : ''}` : String(i + 1);
    return `<button data-i="${i}" class="${i === S.cur ? 'on' : ''} ${sc?.lines.length ? 'ready' : ''} ${act && (flying(act) || act.imps) ? 'busy' : ''}">${label}</button>`;
  }).join('') + (total ? `<span class="total">${total}s</span>` : '');
  $('#pages').innerHTML = S.paras.length > 1 || total ? html : '';
  renderInspector();
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
  const act = activeFor(S.cur) || [...S.scenes.values()].find((x) => flying(x) && x.idx === S.cur && !x.key.endsWith('|old')), sc = act || S.shown; let big = '', small = '', cls = '', tip = '';
  if (sc?.status === 'wait') { cls = 'wait'; big = `${Math.round((performance.now() - sc.t0) / 1000)}s`; small = 'in the Cerebras queue'; }
  else if (sc?.status === 'gen') {
    const secs = Math.max(0.05, (performance.now() - sc.genStart) / 1000); cls = 'gen';
    if (sc.cached) small = 'replaying'; else { big = `≈${Math.round(sc.chars / 1.85 / secs)}`; small = 'tokens/s'; }
  } else if (sc?.status === 'done' && sc.imps?.some((i) => i.status !== 'over')) {
    const gen = sc.imps.find((i) => i.status === 'gen'), waiting = sc.imps.filter((i) => i.status === 'wait');
    if (gen) { cls = 'gen'; const secs = Math.max(0.05, (performance.now() - gen.genStart) / 1000); if (!gen.cached) big = `≈${Math.round(gen.chars / 1.85 / secs)}`; small = `${gen.cached ? '' : 'tokens/s · '}${gen.focus === 'refine' ? 'refining' : 'adding ' + gen.focus}`; }
    else { cls = 'wait'; big = `${Math.round((performance.now() - Math.min(...waiting.map((i) => i.t0))) / 1000)}s`; small = `in queue · ${waiting[0]?.focus === 'motion' ? 'adding motion' : waiting[0]?.focus === 'refine' ? 'refining' : `improving (${waiting.map((i) => i.focus).join(', ')})`}`; }
  } else if (sc?.status === 'done' && sc.done) {
    if (sc.cached) small = 'replayed from cache';
    else { big = `≈${sc.done.tps}`; small = `tokens/s · ${(sc.done.genMs / 1000).toFixed(1)}s`; tip = `${sc.lines.length} lines in ${(sc.done.genMs / 1000).toFixed(1)}s after ${(sc.done.waitMs / 1000).toFixed(0)}s in the queue`; }
  } else if (sc?.status === 'cancelled') { small = 'Cancelled. Press Redraw to send it again';
  } else if (sc?.status === 'error') { cls = 'err'; big = '!'; small = 'Scene failed. Click to retry'; tip = sc.error || ''; }
  const next = nextToImprove(); if (next) improveRound(next);
  const hud = $('#hud'); hud.hidden = !big && !small; hud.className = 'overlay top-right hud ' + cls; hud.title = tip;
  $('#hudBig').textContent = big; $('#hudSmall').textContent = small;

  const runs = [...S.coach.runs.values()];
  const waiting = runs.filter((r) => r.status === 'wait');
  $('#coachStatus').textContent = runs.some((r) => r.status === 'gen') ? 'reading…'
    : waiting.length ? `in queue ${Math.round((performance.now() - Math.min(...waiting.map((r) => r.t0))) / 1000)}s` : S.coach.factBusy ? 'checking facts…' : '';
  $('#reviewBtn').disabled = runs.length > 0 || ta.value.trim().length < 3;
  researchStatus(); blanksStatus();
  const drawable = (S.paras[S.cur]?.text.length || 0) >= 12;
  $('#redrawBtn').disabled = !drawable || Boolean(act && flying(act));
  renderInspector(); renderQueue();
}

// ---------- coach ----------
function setTab(tab) {
  if (tab === 'structure') tab = 'ideas';
  if (!['tips', 'ideas', 'research', 'activity', 'history'].includes(tab)) return;
  S.coach.tab = tab; if (tab === 'history') showHistory(); if (tab === 'activity') { queueSig = ''; setTimeout(renderQueue); }
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
  const blanks = $('#blanks').children.length;
  $('#tipsCount').textContent = tips + blanks || ''; $('#ideasCount').textContent = ideas || '';
  $('#researchCount').textContent = c.research.reduce((n, r) => n + r.lines.filter((o) => o.k === 'finding').length, 0) || '';
  $('#stagesCount').textContent = stages.length && c.shownSeq ? `${done}/${stages.length}` : '';
  $('#structureName').parentElement.hidden = !stages.length;
  $('#reviewBtn').hidden = S.live && !S.paused;
  $('#detailsWrap').hidden = !$('#details').children.length;
  const unsure = $('#unsure').children.length; $('#unsureWrap').hidden = !unsure; $('#unsureWrap summary').textContent = `${unsure} claim${unsure === 1 ? '' : 's'} could not be checked`;
  $('#goodWrap').hidden = !$('#good').children.length; $('#asksWrap').hidden = !$('#asks').children.length; $('#nextWrap').hidden = !$('#next').children.length;
  $('#ideasEmpty').hidden = ideas > 0;
  const empty = $('#tipsEmpty'); empty.hidden = tips > 0 || blanks > 0 || $('#good').children.length > 0;
  empty.textContent = c.runs.size ? 'Reading your draft…'
    : c.shownSeq ? 'No tips left. Keep writing.'
    : ta.value.trim().length < 3 ? 'Write a few lines and the coach will read them.'
    : S.paused ? 'Automatic work is paused. Press Review when you want notes.'
    : S.live ? 'The coach reads your draft each time you pause.' : 'Automatic review is off. Press Review when you want notes.';
}

function resetCoach() {
  const c = S.coach; c.runs.forEach((r) => r.ctrl.abort()); c.runs.clear(); c.factBusy?.abort(); c.factBusy = null; c.factRuns = [];
  Object.assign(c, { tips: [], good: [], hot: null, shownSeq: 0, states: {}, saved: null, allTips: false });
  for (const id of ['tips', 'good', 'unsure', 'asks', 'next', 'details']) $('#' + id).innerHTML = '';
  layoutTips();
  $('#structureName').textContent = S.pack?.structure?.name || 'Structure';
  renderStages(); setTab('tips'); renderCoach();
}
function restoreCoach(saved) {
  if (!saved || saved.pack !== S.pack.id || !Array.isArray(saved.lines)) return;
  const c = S.coach; const run = { seq: ++c.seq, pack: saved.pack };
  for (const o of saved.lines) { if ((o.k === 'tip' || o.k === 'fact') && findQuote(ta.value, o.quote) < 0) continue; coachLine(run, o); }
  const facts = saved.lines.filter((o) => o.k === 'fact' || o.k === 'detail');
  if (facts.length) c.factRuns = [{ quotes: facts.filter((o) => o.k === 'fact').map((o) => o.quote), lines: facts }];
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
  // Notes written under the coach's earlier instructions (v missing) are refreshed once.
  const reviewed = c.saved && c.saved.v === 2 && c.saved.text === text && c.saved.pack === S.pack.id;
  if ((reviewed || S.paused) && force !== true) return;
  if ([...c.runs.values()].some((r) => r.text === text && r.pack === S.pack.id)) return;
  const waiting = [...c.runs.values()].filter((r) => r.status === 'wait').sort((a, b) => a.seq - b.seq);
  waiting.slice(1).forEach((r) => { r.ctrl.abort(); c.runs.delete(r.seq); });
  const run = { seq: ++c.seq, text, pack: S.pack.id, project: S.project?.id, status: 'wait', t0: performance.now(), ctrl: new AbortController(), lines: [], checks: [] };
  c.runs.set(run.seq, run); renderCoach();
  try {
    await sse('/api/coach', { pack: S.pack.id, text, fresh: Boolean(reviewed) }, run.ctrl.signal, (ev) => {
      if (ev.type === 'prompt') run.prompt = ev.text;
      else if (ev.type === 'first') run.status = 'gen';
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (!o) return; if (o.k === 'check') run.checks.push(o); else { run.lines.push(o); coachLine(run, o); } }
      else if (ev.type === 'done') run.status = 'done';
      else if (ev.type === 'error') run.status = 'error';
    });
  } catch { /* aborted or failed */ }
  c.runs.delete(run.seq);
  if (run.status === 'done' && run.seq >= c.shownSeq && run.project === S.project?.id && run.pack === S.pack.id) {
    c.saved = { v: 2, text: run.text, pack: run.pack, lines: run.lines }; markDirty('Coach notes');
    c.lastRun = run; checkFacts(run, Boolean(c.factsNext)); c.factsNext = false;
  }
  renderCoach();
}

// With Review off and Check facts on, the draft is still read for its claims, but no notes are shown.
async function findClaims() {
  const c = S.coach, text = ta.value; if (!S.pack || S.paused || !S.auto.facts || S.live || c.claimsRun || text.trim().length < 3 || c.claimsText === text || (c.saved?.text === text && c.factRuns.length)) return;
  const run = { text, pack: S.pack.id, project: S.project?.id, status: 'wait', t0: performance.now(), ctrl: new AbortController(), checks: [] };
  c.claimsRun = run; let ok = false;
  try {
    await sse('/api/coach', { pack: run.pack, text }, run.ctrl.signal, (ev) => {
      if (ev.type === 'prompt') run.prompt = ev.text;
      else if (ev.type === 'first') run.status = 'gen';
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (o?.k === 'check') run.checks.push(o); }
      else if (ev.type === 'done') ok = true;
    });
  } catch { /* aborted or failed */ }
  if (c.claimsRun === run) c.claimsRun = null;
  if (!ok || run.project !== S.project?.id || run.pack !== S.pack.id) return;
  c.claimsText = text; c.lastRun = run; checkFacts(run);
}

// Fact checks run after the tips, on their own request, and only for claims that were not checked before.
async function checkFacts(run, force = false) {
  const c = S.coach; const has = (q) => findQuote(ta.value, q) >= 0; const show = (o) => { coachLine({ seq: c.shownSeq, pack: run.pack }, o); c.saved?.lines.push(o); };
  for (const fr of c.factRuns) { const alive = fr.quotes.some(has); for (const o of fr.lines) if (o.k === 'fact' ? has(o.quote) : alive) show(o); }
  const known = new Set(c.factRuns.flatMap((fr) => fr.quotes.map((q) => q.toLowerCase())));
  const fresh = run.checks.filter((x) => x.quote && x.query && has(x.quote) && !known.has(String(x.quote).toLowerCase())).slice(0, 3);
  if (!fresh.length || c.factBusy || (!force && (S.paused || !S.auto.facts))) return;
  const ctrl = new AbortController(); Object.assign(ctrl, { t0: performance.now(), status: 'wait', quotes: fresh.map((x) => x.quote) }); c.factBusy = ctrl; const fr = { quotes: fresh.map((x) => x.quote), lines: [] }; let ok = false;
  try {
    await sse('/api/facts', { pack: run.pack, text: run.text, checks: fresh }, ctrl.signal, (ev) => {
      if (ev.type === 'prompt') ctrl.prompt = ev.text;
      else if (ev.type === 'first') ctrl.status = 'gen';
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (!o) return; fr.lines.push(o); if (o.k !== 'fact' || has(o.quote)) show(o); }
      else if (ev.type === 'done') ok = true;
    });
  } catch { /* aborted or failed */ }
  if (c.factBusy !== ctrl) return;
  c.factBusy = null;
  if (ok) { c.factRuns.push(fr); markDirty('Coach notes'); }
}

function coachLine(run, o) {
  const c = S.coach; if (run.pack !== S.pack.id || run.seq < c.shownSeq) return;
  if (run.seq > c.shownSeq) {
    c.shownSeq = run.seq; c.tips = []; c.good = []; c.hot = null; c.allTips = false;
    for (const id of ['tips', 'good', 'unsure', 'asks', 'next', 'details']) $('#' + id).innerHTML = '';
  }
  if (c.dismissed.has(dismissKey(o))) return;
  const rule = S.pack.rules.find((r) => r.id === o.rule); const src = rule && S.pack.sources.find((s) => s.id === rule.source);
  const link = (url, text, title = '') => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(text)}</a>` : `<span title="${esc(title)}">${esc(text)}</span>`);
  const wiki = o.url ? link(o.url, hostOf(o.url), o.title || '') : '';
  const hover = (el) => { el.onmouseenter = () => { c.hot = o; renderBackdrop(); }; el.onmouseleave = () => { c.hot = null; renderBackdrop(); }; };
  // One card shape for coach tips and failed fact checks: what to do, the rewrite, where it comes from.
  const card = (text, from, cls = '', extra = {}) => {
    c.tips.push(o);
    const el = document.createElement('div'); el.className = `card ${cls}` + (o.quote && findQuote(ta.value, o.quote) < 0 ? ' stale' : '');
    const canFix = Boolean(extra.use) || (typeof o.fix === 'string' && Boolean(o.quote) && (o.fix || o.k === 'tip'));
    const fix = extra.fix ?? (o.fix || '');
    el.innerHTML = `<button class="gone" title="Dismiss">×</button><div class="tip">${esc(text)}</div>${fix ? `<div class="fix">${esc(fix)}</div>` : ''}<div class="foot"><span class="rule">${from}</span>${canFix ? `<button class="go">${extra.label || (o.fix ? 'Apply' : 'Cut')}</button>` : ''}</div>`;
    hover(el); tipEls.set(o, el);
    const gone = () => { el.remove(); c.tips = c.tips.filter((t) => t !== o); c.hot = null; layoutTips(); renderBackdrop(); renderCoach(); };
    el.addEventListener('click', (e) => { if (!e.target.closest('a, button') && o.quote) selectQuote(o.quote); });
    el.querySelector('.go')?.addEventListener('click', () => { gone(); (extra.use || applyFix)(o); });
    // A dismissed note stays away: the same note about the same words is not shown again in this project.
    el.querySelector('.gone').addEventListener('click', () => {
      c.dismissed.add(dismissKey(o)); if (c.saved) c.saved.lines = c.saved.lines.filter((l) => l !== o);
      gone(); markDirty('Coach notes');
    });
    if (cls === 'fact') $('#tips').prepend(el); else $('#tips').appendChild(el);
    layoutTips(); renderBackdrop();
  };
  const goodLine = (html) => { c.good.push(o); const el = document.createElement('div'); el.className = 'goodline'; el.innerHTML = html; hover(el); $('#good').appendChild(el); };
  if (o.k === 'tip' && o.tip) card(o.tip, rule ? `<b>${link(src?.url, rule.name, src?.title)}</b>` : '');
  else if (o.k === 'good' && o.note) goodLine(esc(o.note));
  else if (o.k === 'fact' && o.note && o.verdict === 'true') goodLine(`Checks out: ${esc(o.note)} ${wiki}`);
  else if (o.k === 'fact' && o.note && o.verdict === 'false') card(o.note, `<b>Fact check</b>${wiki ? ' · ' + wiki : ''}`, 'fact');
  // A claim the sources neither confirm nor contradict is not a problem with the draft, so it stays out of the tips.
  else if (o.k === 'fact' && o.note) { const el = document.createElement('div'); el.className = 'u'; el.innerHTML = `<q>${esc(o.quote)}</q> ${esc(o.note)} ${wiki}`; $('#unsure').appendChild(el); }
  else if (o.k === 'shot' && (o.show || o.text)) {
    card(o.show ? `Show: ${o.show}` : 'Put this on screen', `<b>${o.inscript ? 'Stage direction in the script' : 'Visual idea'}</b>`, 'shot',
      { fix: o.text ? `On screen: ${o.text}` : '', label: o.inscript ? 'Move to the scene' : 'Use for the scene', use: useShot });
  }
  else if (o.k === 'detail' && o.text) {
    const el = document.createElement('div'); el.className = 'detail';
    el.innerHTML = `<button class="line">${esc(o.text)}</button>${wiki ? `<span class="src">${wiki}</span>` : ''}`;
    el.querySelector('button').onclick = () => { addLine(o.text, 'Added a fact'); el.remove(); renderCoach(); };
    $('#details').appendChild(el);
  } else if (o.k === 'stage' && o.id) { c.states[o.id] = o; renderStages(); }
  else if (o.k === 'ask' && o.text) { const el = document.createElement('div'); el.className = 'line'; el.textContent = o.text; $('#asks').appendChild(el); }
  else if (o.k === 'next' && o.text) {
    const el = document.createElement('button'); el.className = 'line'; el.textContent = o.text;
    el.onclick = () => { addLine(o.text, 'Added a suggested line'); el.remove(); renderCoach(); };
    $('#next').appendChild(el);
  }
  renderCoach();
}
const dismissKey = (o) => `${o.k}|${o.rule || ''}|${String(o.quote || o.show || o.text || '').toLowerCase()}`;
// A visual idea goes to the scene, never into the script: what to show becomes the scene's direction and the
// words become its on-screen text. If the idea was written into the script, it is taken out of it first.
function useShot(o) {
  let idx = S.cur; const i = o.quote ? findQuote(ta.value, o.quote) : -1;
  if (i >= 0) {
    if (o.inscript) {
      const a = ta.value.slice(0, i).replace(/[ \t]+$/, ''), b = ta.value.slice(i + o.quote.length).replace(/^[ \t]+/, '');
      ta.value = (a + (a && b && !a.endsWith('\n') && !b.startsWith('\n') ? ' ' : '') + b).replace(/\n{3,}/g, '\n\n');
      S.paras = paragraphs(ta.value);
    }
    const pos = Math.min(i, ta.value.length); idx = S.paras.findIndex((p) => pos <= p.end); if (idx < 0) idx = S.paras.length - 1;
  }
  if (o.inscript && i >= 0) { const p = S.paras[idx]; if (p) ta.setSelectionRange(p.start, p.start); onText(true); markDirty('Moved a stage direction out of the script'); }
  if (!S.paras[idx]) return;
  if (o.show) guideScene(idx, o.show, o.text || undefined); else if (o.text) setCaption(idx, o.text);
  moved(true);
}

// ---------- blanks ----------
// A blank is a slot in square brackets the writer still has to fill, like [specific cooling step].
// The coach suggests what could go in each one; a click puts the suggestion into the draft.
const BLANK = /\[(?=[^\]]*[A-Za-z])[^\[\]\n]{2,60}\](?!\()/g;
const blanksIn = (text) => [...new Set([...text.matchAll(BLANK)].map((m) => m[0]))];
// [Cut to ...] and [Text: ...] are stage directions, not blanks: they belong to the scene, not the script.
const STAGE_DIR = /^\[\s*(cut to|text\s*:|on[- ]?screen|b-?roll|show|visual|shot|sfx|caption\s*:)/i;
const directionOf = (slot) => { const inner = slot.slice(1, -1).trim(), m = /^(text|caption|on[- ]?screen(?: text)?)\s*:\s*/i.exec(inner); return m ? { quote: slot, inscript: true, text: inner.slice(m[0].length) } : { quote: slot, inscript: true, show: inner }; };
const sameSlot = (a, b) => String(a).replace(/[\[\]]/g, '').trim().toLowerCase() === String(b).replace(/[\[\]]/g, '').trim().toLowerCase();
function restoreFills(saved) {
  const f = S.coach.fills; f.busy?.abort(); f.busy = null; f.opts = new Map(); f.asked = new Set();
  for (const x of Array.isArray(saved) ? saved : []) if (x?.slot && Array.isArray(x.opts)) { f.opts.set(x.slot, x.opts); f.asked.add(x.slot); }
  renderBlanks(true);
}
let blanksSig = '';
function renderBlanks(force = false) {
  const f = S.coach.fills, slots = blanksIn(ta.value);
  const auto = S.auto.blanks && !S.paused;
  const sig = slots.map((s) => `${s}|${(f.opts.get(s) || []).length}|${f.asked.has(s) ? 1 : 0}|${f.busy?.slots.includes(s) ? 1 : 0}`).join('\n') + auto;
  if (!force && sig === blanksSig) return;
  blanksSig = sig; $('#blanksWrap').hidden = !slots.length;
  $('#fillAllBtn').hidden = slots.filter((x) => !STAGE_DIR.test(x)).length < 2;
  $('#blanks').innerHTML = slots.map((slot) => {
    if (STAGE_DIR.test(slot)) return `<div class="blank" data-slot="${esc(slot)}"><button class="slot" data-act="select" title="Show it in the draft">${esc(slot)}</button><p class="empty">This is a stage direction, not something you say. <button class="link" data-act="move">Move it to the scene</button></p></div>`;
    const opts = f.opts.get(slot) || [], picks = opts.filter((o) => o.text), search = opts.find((o) => o.search)?.search;
    const rows = picks.map((o) => `<div class="detail"><button class="line" data-j="${opts.indexOf(o)}" title="Put this in the blank">${esc(o.text)}</button>`
      + (o.url || o.who ? `<span class="src">${esc(o.who || '')}${o.who && o.url ? ' · ' : ''}${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener" title="${esc(o.title || '')}">${esc(hostOf(o.url))}</a>` : ''}</span>` : '') + '</div>').join('');
    const hint = f.busy?.slots.includes(slot) ? '<p class="empty" data-wait></p>'
      : picks.length ? ''
      : f.asked.has(slot) ? `<p class="empty">No source covers this yet. <button class="link" data-act="agent" data-search="${esc(search || '')}">Send the agent to find it</button></p>`
      : auto ? '<p class="empty">Suggestions come when you pause.</p>' : '<p class="empty"><button class="link" data-act="suggest">Suggest what goes here</button></p>';
    return `<div class="blank" data-slot="${esc(slot)}"><button class="slot" data-act="select" title="Show it in the draft">${esc(slot)}</button>${rows}${hint}</div>`;
  }).join('');
  blanksStatus();
}
function blanksStatus() {
  const run = S.coach.fills.busy; if (!run) return;
  const text = run.status === 'gen' ? 'Reading the sources…' : `Finding suggestions. In queue ${Math.round((performance.now() - run.t0) / 1000)}s`;
  $$('#blanks [data-wait]').forEach((el) => { el.textContent = text; });
}
// Runs by itself when the writer pauses: one request covers every blank that has no suggestions yet.
async function runFills(force = false) {
  const f = S.coach.fills; if (!S.pack || f.busy) return;
  if (force !== true && (S.paused || !S.auto.blanks)) return;
  const slots = blanksIn(ta.value).filter((s) => !STAGE_DIR.test(s)).filter((s) => !f.asked.has(s) || (force === true && !(f.opts.get(s) || []).some((o) => o.text))).slice(0, 6);
  if (!slots.length) return;
  const run = Object.assign(new AbortController(), { slots, t0: performance.now(), status: 'wait' }); f.busy = run; renderBlanks(true);
  const fresh = new Set();
  try {
    await sse('/api/fill', { pack: S.pack.id, text: ta.value, slots }, run.signal, (ev) => {
      if (ev.type === 'prompt') run.prompt = ev.text;
      else if (ev.type === 'first') run.status = 'gen';
      else if (ev.type === 'line') {
        const o = parseLine(ev.raw), slot = o && slots.find((x) => sameSlot(x, o.slot)); if (!slot || f.busy !== run) return;
        if (!fresh.has(slot)) { fresh.add(slot); f.opts.set(slot, []); }
        const list = f.opts.get(slot); if (list.length < 3 && !list.some((x) => x.text === o.text)) list.push({ ...o, slot });
        renderBlanks(true); renderCoach();
      }
    });
  } catch { /* aborted or failed */ }
  if (f.busy !== run) return;
  f.busy = null; slots.forEach((s) => f.asked.add(s));
  if (fresh.size) markDirty('Coach notes');
  renderBlanks(true); renderCoach();
  runFills();
}
function pickFill(slot, o) {
  const i = ta.value.indexOf(slot); if (i < 0) return;
  ta.value = ta.value.split(slot).join(o.text);
  ta.focus(); ta.setSelectionRange(i, i + o.text.length); S.coach.hotSlot = null; onText(); markDirty(`Filled ${slot}`);
}
$('#blanks').addEventListener('click', (e) => {
  const box = e.target.closest('.blank'), b = e.target.closest('button'); if (!box || !b) return;
  const slot = box.dataset.slot, f = S.coach.fills;
  if (b.dataset.j) pickFill(slot, f.opts.get(slot)[Number(b.dataset.j)]);
  else if (b.dataset.act === 'select') selectQuote(slot);
  else if (b.dataset.act === 'suggest') runFills(true);
  else if (b.dataset.act === 'move') useShot(directionOf(slot));
  else if (b.dataset.act === 'agent') { setTab('research'); ask(`Find ${b.dataset.search || 'what goes in ' + slot} and fill in the blank ${slot}`); }
});
$('#blanks').addEventListener('mouseover', (e) => { const slot = e.target.closest('.blank')?.dataset.slot; if (slot !== S.coach.hotSlot) { S.coach.hotSlot = slot; renderBackdrop(); } });
$('#blanks').addEventListener('mouseleave', () => { S.coach.hotSlot = null; renderBackdrop(); });
$('#fillAllBtn').onclick = () => { setTab('research'); ask('Fill in every blank in square brackets with spoken words. Leave stage directions like [Cut to ...] and [Text: ...] alone.'); };

// ---------- agent ----------
// The writer sends the agent to do a job: look something up, fill the blanks, rewrite the draft, or all of it.
// Sources show as soon as the search returns. Changes go straight into the draft when the answer lands,
// with an Undo on the card and a version in History; findings are one click away from the draft.
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'source'; } };
const wordCount = (t) => (String(t).match(/\S+/g) || []).length;
function restoreResearch(saved) {
  const c = S.coach; c.research.forEach((r) => r.ctrl?.abort());
  c.research = (Array.isArray(saved) ? saved : []).filter((r) => r && r.q).map((r) => ({ q: String(r.q), sources: r.sources || [], lines: r.lines || [], rewrote: r.rewrote, status: 'done' }));
  renderResearch();
}
function renderResearch() {
  const c = S.coach;
  $('#researchEmpty').hidden = c.research.length > 0;
  $('#research').innerHTML = c.research.map((r, i) => {
    const answer = r.lines.find((o) => o.k === 'answer'), over = r.status === 'done';
    const link = (o) => (o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener" title="${esc(o.title)}">${esc(hostOf(o.url))}</a>` : '');
    const finds = r.lines.map((o, j) => (o.k !== 'finding' ? '' : `<div class="detail"><button class="line" data-i="${i}" data-j="${j}" title="Add to the draft">${esc(o.text)}</button><span class="src">${esc(o.who || '')}${o.who ? ' · ' : ''}${link(o)}</span></div>`)).join('');
    const edits = r.lines.map((o) => (o.k !== 'edit' ? '' : `<div class="chg ${o.missed ? 'missed' : ''}"><s>${esc(o.quote)}</s> <b>${esc(o.text) || '(cut)'}</b><span class="src">${[o.missed ? 'Not applied: those words are no longer in the draft' : esc(o.note || ''), link(o)].filter(Boolean).join(' · ')}</span></div>`)).join('');
    const rewrote = r.rewrote ? `<div class="chg"><b>Rewrote the draft</b><span class="src">${r.rewrote[0]} words before, ${r.rewrote[1]} after</span></div>` : '';
    const held = over && r.held ? `<div class="chg"><b>The draft changed while the agent worked.</b><span class="src">Its rewrite was made from the earlier text.</span><button class="mini" data-apply="${i}">Use the rewrite anyway</button></div>` : '';
    const undo = r.after != null ? `<div class="rs-undo" data-u="${i}"><button class="mini" data-undo="${i}">Undo these changes</button><span class="src">Edited since. Use History to go back.</span></div>` : '';
    const srcs = r.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${esc(hostOf(s.url))}${s.published ? ' ' + esc(s.published.slice(0, 4)) : ''} · ${esc(s.title)}</a>`).join('');
    return `<div class="rs"><div class="rs-q"><span>${esc(r.q)}</span><button class="mini" data-x="${i}" title="${r.status === 'done' || r.status === 'error' ? 'Remove' : 'Stop'}">×</button></div>`
      + `<div class="rs-status ${r.status === 'error' ? 'err' : ''}" data-s="${i}"></div>`
      + (answer ? `<div class="line answer">${esc(answer.text)}</div>` : '') + (over ? rewrote + edits + held + undo : '') + finds
      + (srcs ? `<div class="rs-srcs"><h3>Sources read</h3>${srcs}</div>` : '') + '</div>';
  }).join('');
  researchStatus(); renderCoach();
}
function researchStatus() {
  S.coach.research.forEach((r, i) => {
    const u = $(`#research [data-u="${i}"]`); if (u) u.classList.toggle('late', ta.value !== r.after);
    const el = $(`#research [data-s="${i}"]`); if (!el) return;
    const secs = Math.round((performance.now() - (r.t0 || 0)) / 1000), n = r.sources.length;
    el.textContent = r.status === 'search' ? 'Searching the web…'
      : r.status === 'wait' ? `${n ? `Found ${n} source${n === 1 ? '' : 's'}. ` : ''}In the queue: ${secs}s`
      : r.status === 'gen' ? 'Working…'
      : r.status === 'error' ? (r.error || 'That did not work. Try again.') : '';
    el.hidden = !el.textContent;
  });
}
// Puts the agent's changes into the draft. A full rewrite made from text that has since changed is held back for the writer to decide.
async function applyAgent(r, anyway = false) {
  const edits = r.lines.filter((o) => o.k === 'edit'), paras = r.lines.filter((o) => o.k === 'draft');
  if (!edits.length && !paras.length) return;
  if (paras.length && ta.value !== r.sent && !anyway) { r.held = true; return; }
  // What was typed up to now is saved first, so History keeps the state from just before the agent's change.
  await saveNow();
  const before = ta.value; let text = paras.length ? paras.map((o) => o.text.trim()).join('\n\n') : before;
  for (const o of edits) {
    const i = findQuote(text, o.quote); if (i < 0) { o.missed = true; continue; }
    text = text.slice(0, i) + o.text + text.slice(i + o.quote.length);
  }
  r.held = false; if (text === before) return;
  if (paras.length) r.rewrote = [wordCount(before), wordCount(text)];
  r.before = before; r.after = text; ta.value = text; onText(true); markDirty(`Agent: ${r.q.slice(0, 60)}`);
}
async function ask(q) {
  const c = S.coach; q = q.trim(); if (!S.pack || q.length < 3) return;
  const r = { q, sent: ta.value, sources: [], lines: [], status: 'search', t0: performance.now(), ctrl: new AbortController(), project: S.project?.id };
  c.research.unshift(r); renderResearch();
  try {
    await sse('/api/ask', { pack: S.pack.id, text: r.sent, ask: q }, r.ctrl.signal, (ev) => {
      if (ev.type === 'prompt') r.prompt = ev.text;
      else if (ev.type === 'sources') { r.sources = ev.sources || []; r.status = 'wait'; }
      else if (ev.type === 'first') r.status = 'gen';
      else if (ev.type === 'line') { const o = parseLine(ev.raw); if (o) r.lines.push(o); }
      else if (ev.type === 'done') r.status = 'done';
      else if (ev.type === 'error') { r.status = 'error'; r.error = ev.message; }
      if (c.research.includes(r)) renderResearch();
    });
    if (r.status !== 'done' && r.status !== 'error') r.status = r.lines.length ? 'done' : 'error';
  } catch (e) { if (r.ctrl.signal.aborted) return; r.status = 'error'; r.error = String(e.message || e); }
  if (!c.research.includes(r) || r.project !== S.project?.id) return;
  if (r.status === 'done' && !r.lines.some((o) => ['finding', 'answer', 'edit', 'draft'].includes(o.k))) { r.status = 'error'; r.error = 'Nothing came back. Try other words.'; }
  if (r.status === 'done') { await applyAgent(r); markDirty(r.after != null ? undefined : 'Coach notes'); }
  renderResearch();
}
$('#research').addEventListener('click', async (e) => {
  const c = S.coach, x = e.target.closest('[data-x]'), f = e.target.closest('button.line'), u = e.target.closest('[data-undo]'), a = e.target.closest('[data-apply]');
  if (x) { const [r] = c.research.splice(Number(x.dataset.x), 1); r?.ctrl?.abort(); renderResearch(); markDirty('Coach notes'); }
  else if (f) { const r = c.research[Number(f.dataset.i)]; const [o] = r.lines.splice(Number(f.dataset.j), 1); addLine(o.text, 'Added a finding'); renderResearch(); }
  else if (u) {
    const r = c.research[Number(u.dataset.undo)]; if (ta.value !== r.after) return;
    ta.value = r.before; r.after = null; r.rewrote = null; r.lines = r.lines.filter((o) => o.k !== 'edit' && o.k !== 'draft');
    onText(true); markDirty(`Undid agent: ${r.q.slice(0, 50)}`); renderResearch();
  } else if (a) { const r = c.research[Number(a.dataset.apply)]; await applyAgent(r, true); renderResearch(); }
});

// ---------- history ----------
// Every version the server has kept of this project: the text, the drawings and the coach's notes.
function verLine(v, i) {
  const bits = [new Date(v.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })];
  if (v.words >= 0) bits.push(`${v.words} word${v.words === 1 ? '' : 's'}`, `${v.scenes} drawing${v.scenes === 1 ? '' : 's'}`);
  return `<div class="ver" data-rev="${esc(v.rev)}"><div class="ver-head"><div><b>${esc(v.label)}</b><small>${i ? '' : 'Current · '}${esc(bits.join(' · '))}</small></div>`
    + `<button class="mini" data-act="view">View</button>${i ? '<button class="mini" data-act="restore">Restore</button>' : ''}</div><pre hidden></pre></div>`;
}
async function showHistory() {
  if (!S.project) return;
  const note = $('#historyEmpty'); note.hidden = false; note.textContent = 'Loading…'; $('#history').innerHTML = '';
  try {
    await saveNow();
    const r = await api('GET', `/api/projects/${S.project.id}/versions`);
    $('#history').innerHTML = r.versions.map(verLine).join('');
    note.hidden = r.versions.length > 0; note.textContent = r.off ? 'Version history is off on this server (git is missing).' : 'No versions yet.';
  } catch (e) { note.textContent = 'Could not load the history. ' + String(e.message || e).slice(0, 120); }
}
$('#history').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'), row = e.target.closest('.ver'); if (!b || !row) return;
  const pre = row.querySelector('pre');
  if (b.dataset.act === 'view' && !pre.hidden) { pre.hidden = true; b.textContent = 'View'; return; }
  const v = await api('GET', `/api/projects/${S.project.id}/versions/${row.dataset.rev}`);
  if (b.dataset.act === 'view') { pre.textContent = v.text || '(empty)'; pre.hidden = false; b.textContent = 'Hide'; return; }
  await saveNow();
  const when = row.querySelector('small').textContent.split(' · ')[0];
  loadProject({ ...v, id: S.project.id, createdAt: S.project.createdAt });
  markDirty(`Restored the version from ${when}`); await saveNow();
  ta.focus();
});

function addLine(text, why = 'Added a line') { const v = ta.value.replace(/\s+$/, ''); ta.value = v + (v ? ' ' : '') + text; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); onText(); markDirty(why); }
function selectQuote(q) { const i = findQuote(ta.value, q); if (i < 0) return; ta.focus(); ta.setSelectionRange(i, i + q.length); moved(true); }
function applyFix(o) {
  const i = findQuote(ta.value, o.quote); if (i < 0) return;
  ta.value = ta.value.slice(0, i) + o.fix + ta.value.slice(i + o.quote.length);
  S.coach.tips = S.coach.tips.filter((t) => t !== o); S.coach.hot = null; ta.focus(); ta.setSelectionRange(i, i + o.fix.length); onText(); markDirty(o.k === 'fact' ? 'Applied a fact fix' : 'Applied a tip');
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
// Every request is timed, so Activity can show where the minutes went.
const kindOf = (url, body) => (url === '/api/scene' ? (body.improve ? (body.focus === 'motion' ? 'Motion' : 'Improving looks') : 'Drawing scenes')
  : { '/api/coach': 'Reviewing the draft', '/api/facts': 'Checking facts', '/api/fill': 'Suggesting blanks', '/api/ask': 'Agent' }[url] || url);
async function sse(url, body, signal, onEvent) {
  const kind = kindOf(url, body), t0 = performance.now(); let first = 0;
  const tally = () => {
    const v = S.spent.get(kind) || { n: 0, wait: 0, gen: 0, stopped: 0 }, now = performance.now();
    v.n++; v.wait += (first || now) - t0; v.gen += first ? now - first : 0; if (signal?.aborted) v.stopped++;
    S.spent.set(kind, v);
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const row = buf.slice(0, i); buf = buf.slice(i + 2);
        if (row.startsWith('data:')) { try { const ev = JSON.parse(row.slice(5)); if (ev.type === 'first' && !first) first = performance.now(); onEvent(ev); } catch (e) { console.warn(e); } }
      }
    }
  } finally { tally(); }
}

boot();
