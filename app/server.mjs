// Story visualiser server. Every model call goes through the local OpenClaw
// gateway (agents "illustrator" and "coach"), which runs Kimi K3.1 Pro on Cerebras.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:18789';
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ||
  JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw/openclaw.json'), 'utf8')).gateway.auth.token;

const CACHE = path.join(ROOT, '..', 'cache');
fs.mkdirSync(CACHE, { recursive: true });

// Projects are one JSON file each, kept outside app/ so a deploy never touches them.
const PROJECTS = path.join(ROOT, '..', 'data', 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });
const projectFile = (id) => (/^[a-z0-9]{6,32}$/.test(id) ? path.join(PROJECTS, id + '.json') : null);

function listProjects() {
  const out = [];
  for (const f of fs.readdirSync(PROJECTS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8'));
      out.push({ id: p.id, name: p.name, pack: p.pack, updatedAt: p.updatedAt, words: (String(p.text || '').match(/\S+/g) || []).length });
    } catch (e) { console.error('bad project', f, e.message); }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveProject(id, b) {
  const p = {
    id, name: String(b.name || 'Untitled').slice(0, 80), pack: String(b.pack || ''), text: String(b.text || '').slice(0, 200_000),
    scenes: Array.isArray(b.scenes) ? b.scenes.slice(0, 200) : [], coach: b.coach && typeof b.coach === 'object' ? b.coach : null,
    research: Array.isArray(b.research) ? b.research.slice(0, 30) : [],
    createdAt: Number(b.createdAt) || Date.now(), updatedAt: Date.now(),
  };
  const file = projectFile(id), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p)); fs.renameSync(tmp, file);
  return p;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function loadPacks() {
  const dir = path.join(ROOT, 'packs');
  const order = ['children-story', 'short-story', 'short-video-script', 'engineering-docs'];
  const packs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { packs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
    catch (e) { console.error('bad pack', f, e.message); }
  }
  packs.sort((a, b) => (order.indexOf(a.id) + 99) % 99 - (order.indexOf(b.id) + 99) % 99);
  return packs;
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

function readBody(req, limit = 400_000) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > limit) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  return (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
}

// An agent's instructions are part of the cache key, so editing a prompt never replays answers written under the old one.
const promptHash = (agent) => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'agents', `${agent}.AGENTS.md`))).digest('hex').slice(0, 10); }
  catch { return ''; }
};

// Run one agent turn through the OpenClaw gateway and forward complete lines as SSE events.
// `shape` can rewrite a line before it is sent, or return null to keep it from the page.
// Returns { lines, done } (the caller sends `done` and ends the response), or null after an error.
async function runAgent(res, send, agent, userText, { maxTokens = 6000, charsPerToken = 3.4, useCache = true, shape = (l) => l } = {}) {
  const forward = (line, ms) => { const out = shape(line); if (out) send({ type: 'line', raw: out, ms }); };
  // Identical requests replay from disk, clearly marked as cached, so reloads and retakes are instant.
  const cacheFile = path.join(CACHE, crypto.createHash('sha1').update(agent + promptHash(agent) + '\n' + userText).digest('hex') + '.json');
  if (useCache && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      send({ type: 'first', waitMs: 0, cached: true });
      for (const raw of c.lines) { forward(raw, 0); await new Promise((r) => setTimeout(r, 25)); }
      logRun(agent, userText, 'cached', { lines: c.lines.length });
      return { lines: c.lines, done: { ...c.done, cached: true } };
    } catch { /* fall through to a live run */ }
  }
  const kept = [];
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  const t0 = Date.now();
  let first = 0, chars = 0, buf = '', usage = null;
  const beat = setInterval(() => { if (!first) send({ type: 'wait', ms: Date.now() - t0 }); }, 1000);
  const emitLine = (line) => {
    line = line.trim();
    if (!line || line.startsWith('```')) return;
    kept.push(line); forward(line, Date.now() - t0);
  };
  try {
    const up = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `openclaw/${agent}`, stream: true, max_completion_tokens: maxTokens,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!up.ok) throw new Error(`gateway ${up.status}: ${(await up.text()).slice(0, 300)}`);
    const dec = new TextDecoder();
    let sse = '';
    for await (const chunk of up.body) {
      sse += dec.decode(chunk, { stream: true });
      let i;
      while ((i = sse.indexOf('\n')) >= 0) {
        const row = sse.slice(0, i).trim(); sse = sse.slice(i + 1);
        if (!row.startsWith('data:')) continue;
        const data = row.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        if (j.error) throw new Error(j.error.message || 'gateway stream error');
        const delta = j.choices?.[0]?.delta?.content;
        if (!delta) continue;
        if (!first) { first = Date.now(); send({ type: 'first', waitMs: first - t0 }); }
        chars += delta.length; buf += delta;
        let k;
        while ((k = buf.indexOf('\n')) >= 0) { emitLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
      }
    }
    if (buf.trim()) emitLine(buf);
    const genMs = first ? Date.now() - first : 0;
    // Speed counts visible output only. The gateway's usage total also includes Kimi's hidden
    // reasoning tokens, which are produced before the first visible character, so it is not used here.
    const tokens = Math.round(chars / charsPerToken);
    const total = usage?.completion_tokens || 0;
    const done = {
      type: 'done', waitMs: first ? first - t0 : Date.now() - t0, genMs, chars, lines: kept.length, tokens, totalTokens: total,
      tps: genMs > 0 ? Math.round(tokens / (genMs / 1000)) : 0,
    };
    const cutOff = total >= maxTokens * 0.98;
    if (kept.length >= 2 && !cutOff) fs.writeFile(cacheFile, JSON.stringify({ agent, lines: kept, done }), () => {});
    logRun(agent, userText, cutOff ? 'cutoff' : kept.length ? 'done' : 'empty', done);
    return { lines: kept, done };
  } catch (e) {
    if (!ac.signal.aborted) send({ type: 'error', message: String(e.message || e) });
    logRun(agent, userText, ac.signal.aborted ? 'aborted' : 'error', { waitMs: first ? first - t0 : Date.now() - t0, lines: kept.length, error: ac.signal.aborted ? undefined : String(e.message || e).slice(0, 200) });
    return null;
  } finally {
    clearInterval(beat); res.off('close', onClose);
  }
}

// One line per model request in the journal: `journalctl -u storyviz -o cat | grep '^{'` is the app's own record
// of what was asked, how long it sat in the queue and how it ended.
function logRun(agent, userText, outcome, d = {}) {
  console.log(JSON.stringify({
    t: new Date().toISOString(), agent, kind: String(userText).split('\n')[0].slice(0, 40), outcome,
    waitMs: d.waitMs, genMs: d.genMs, tokens: d.tokens, totalTokens: d.totalTokens, lines: d.lines, promptChars: userText.length, error: d.error,
  }));
}

const parseLine = (raw) => { try { return JSON.parse(String(raw).trim().replace(/,\s*$/, '')); } catch { return null; } };

// ---------- research ----------
// Sources come from a web search through Exa's public MCP endpoint, which needs no key. Wikipedia is the
// fallback when Exa is down or returns nothing. Neither is a model call, so both answer in about a second.
async function exa(query, n = 4, clip = 1800) {
  const res = await fetch('https://mcp.exa.ai/mcp', {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query: String(query).slice(0, 400), numResults: n } } }),
  });
  if (!res.ok) throw new Error('exa ' + res.status);
  const row = (await res.text()).split('\n').map((l) => (l.startsWith('data:') ? l.slice(5) : l).trim()).find((l) => l.startsWith('{'));
  const j = JSON.parse(row || '{}');
  if (j.error || j.result?.isError) throw new Error('exa: ' + String(j.error?.message || j.result?.content?.[0]?.text || 'failed').slice(0, 160));
  const text = (j.result?.content || []).map((c) => c.text || '').join('\n');
  return text.split(/\n(?=Title: )/).map((block) => {
    const title = /^Title: (.+)$/m.exec(block)?.[1], url = /^URL: (https?:\S+)$/m.exec(block)?.[1];
    const body = (block.split(/^(?:Highlights|Text):[ \t]*$/m)[1] || '').replace(/\n{2,}/g, '\n').trim();
    return title && url && body.length > 80 ? { title: title.slice(0, 140), url, published: /^Published: (\d{4}-\d\d-\d\d)/m.exec(block)?.[1] || '', text: body.slice(0, clip) } : null;
  }).filter(Boolean);
}
async function wiki(params) {
  const res = await fetch('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', ...params }), {
    headers: { 'User-Agent': 'storyviz/1.0 (writing tool; fact lookup)' }, signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error('wikipedia ' + res.status);
  return res.json();
}
async function wikiSources(queries, max = 6) {
  const hits = await Promise.all(queries.map(async (q) => {
    try {
      const j = await wiki({ action: 'query', list: 'search', srsearch: String(q).slice(0, 120), srlimit: '3' });
      return (j.query?.search || []).map((h) => h.title);
    } catch (e) { console.error('search failed', q, e.message); return []; }
  }));
  const titles = [];
  for (let rank = 0; rank < 3; rank++) for (const list of hits) if (list[rank] && !titles.includes(list[rank])) titles.push(list[rank]);
  const pages = await Promise.all(titles.slice(0, max).map(async (title) => {
    try {
      const j = await wiki({ action: 'query', prop: 'extracts', explaintext: '1', exchars: '2200', redirects: '1', titles: title });
      const page = Object.values(j.query?.pages || {})[0];
      const text = String(page?.extract || '').replace(/\n{2,}/g, '\n').trim();
      return text.length > 80 ? { title: page.title + ' (Wikipedia)', url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(page.title.replace(/ /g, '_')), published: '', text } : null;
    } catch (e) { console.error('extract failed', title, e.message); return null; }
  }));
  return pages.filter(Boolean);
}
// Wikipedia's search wants a topic, not a sentence: keep the words that carry the subject.
const STOP = new Set('a an the of on in at to for and or but with about how much many does do did is are was were be can could should would i we you it its my our me us get find give tell show research look up into facts fact figures numbers actually really some any that this what which who when where why please need want'.split(' '));
const topicOf = (q) => (String(q).toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !STOP.has(w)).slice(0, 6).join(' ') || String(q);

// The coach names the claims worth checking; each one is searched in its own words.
async function research(checks) {
  const lists = await Promise.all(checks.map(async (c) => {
    try { return await exa(`${c.quote} (${c.query})`, 2, 1500); } catch (e) { console.error('exa failed', e.message); return []; }
  }));
  // Take every claim's best hit before anyone's second, so one claim cannot use up all the source slots.
  const out = [];
  for (let rank = 0; rank < 2; rank++) for (const list of lists) if (list[rank] && !out.some((s) => s.url === list[rank].url)) out.push(list[rank]);
  return out.length ? out.slice(0, 6) : wikiSources(checks.map((c) => c.query));
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const sourceList = (sources) => sources.map((s, i) => `[${i + 1}] ${s.title} (${[host(s.url), s.published].filter(Boolean).join(', ')})\n${s.text}`).join('\n\n');
function factRequest(pack, text, checks, sources) {
  return [
    'mode: fact check', `writing type: ${pack.name}`,
    `draft:\n"""\n${String(text).slice(0, 9000)}\n"""`,
    `claims to check:\n${checks.map((c) => JSON.stringify({ quote: c.quote })).join('\n')}`,
    `sources:\n${sourceList(sources)}`,
  ].join('\n\n');
}
function askRequest(pack, text, ask, sources) {
  return [
    'mode: research', `writing type: ${pack.name}`,
    `the writer asks:\n"""\n${ask}\n"""`,
    `draft:\n"""\n${String(text).slice(0, 5000)}\n"""`,
    `sources:\n${sourceList(sources)}`,
  ].join('\n\n');
}

// The writer sends the coach to look something up. The sources go to the page as soon as the search
// returns, so there is something to read while the model request waits in the queue.
async function streamAsk(res, pack, text, ask) {
  const send = openStream(res);
  let sources = [];
  try { sources = await exa(ask, 6); } catch (e) { console.error('exa failed', e.message); }
  if (!sources.length) sources = await wikiSources([topicOf(ask)], 4);
  send({ type: 'sources', sources: sources.map(({ title, url, published }) => ({ title, url, published })) });
  if (!sources.length) { send({ type: 'error', message: 'No sources found. Try other words.' }); res.end(); return; }
  // A finding must name a real source; it reaches the page with that source's title and link.
  const cite = (l) => {
    const o = parseLine(l); if (!o) return null;
    if (o.k === 'answer') return o.text ? JSON.stringify({ k: 'answer', text: o.text }) : null;
    const s = sources[Number(o.src) - 1]; if (o.k !== 'finding' || !o.text || !s) return null;
    delete o.src; return JSON.stringify({ ...o, title: s.title, url: s.url });
  };
  const r = res.destroyed ? null : await runAgent(res, send, 'coach', askRequest(pack, text, ask, sources), { maxTokens: 3500, shape: cite });
  if (r) send(r.done);
  res.end();
}

// A separate request from the coach's, so a slow fact check never holds up the tips.
async function streamFacts(res, pack, text, checks) {
  const send = openStream(res);
  const sources = checks.length ? await research(checks) : [];
  // Kimi cites a source by number; the page gets its title and link instead.
  const cite = (l) => {
    const o = parseLine(l); if (!o || (o.k !== 'fact' && o.k !== 'detail')) return null;
    const s = sources[Number(o.src) - 1]; delete o.src;
    if (!s && (o.k === 'detail' || o.verdict !== 'unclear')) return null;
    return JSON.stringify(s ? { ...o, title: s.title, url: s.url } : o);
  };
  const r = sources.length && !res.destroyed ? await runAgent(res, send, 'coach', factRequest(pack, text, checks, sources), { maxTokens: 3000, shape: cite }) : { done: { type: 'done', lines: 0 } };
  if (r) send(r.done);
  res.end();
}

function sceneRequest(b) {
  const mode = ['diorama', 'storyboard', 'diagram'].includes(b.mode) ? b.mode : 'diorama';
  const parts = [`mode: ${mode}`, `strict: ${b.strict ? 'yes' : 'no'}`];
  if (b.kind) parts.push(`writing type: ${String(b.kind).slice(0, 60)}`);
  if (b.index != null) parts.push(`paragraph number: ${Number(b.index) + 1} of ${Number(b.total) || 1}`);
  if (b.context) parts.push(`earlier paragraphs (for continuity only, do not draw them):\n${String(b.context).slice(-1500)}`);
  if (b.cast) parts.push(`cast from the previous scene (reuse an obj line unchanged if the same thing appears again):\n${String(b.cast).slice(0, 3500)}`);
  parts.push(`paragraph to draw:\n"""\n${String(b.paragraph || '').slice(0, 2500)}\n"""`);
  if (b.update) {
    parts.unshift('task: update');
    parts.push(`the paragraph before the edit:\n"""\n${String(b.before || '').slice(0, 2500)}\n"""`, `scene on screen now, drawn for the paragraph before the edit:\n${String(b.scene || '').slice(0, 24000)}`);
  }
  if (b.improve) {
    parts.unshift('task: improve', `focus: ${['subject', 'setting', 'background', 'polish'].includes(b.focus) ? b.focus : 'polish'}`);
    parts.push(`scene on screen now:\n${String(b.scene || '').slice(0, 24000)}`);
  }
  return parts.join('\n\n');
}

function coachRequest(pack, text) {
  const slim = {
    type: pack.name,
    factual: Boolean(pack.factual),
    accepted_shapes: pack.shapes,
    structure: pack.structure,
    rules: pack.rules.map((r) => ({ id: r.id, name: r.name, rule: r.rule, look_for: r.look_for, not_a_problem: r.ok, bad: r.bad, good: r.good })),
  };
  return `guide pack:\n${JSON.stringify(slim)}\n\ndraft:\n"""\n${String(text).slice(0, 9000)}\n"""`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/packs') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(loadPacks())); return;
    }
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, listProjects());
    if (url.pathname.startsWith('/api/projects/')) {
      const id = url.pathname.slice('/api/projects/'.length), file = projectFile(id);
      if (!file) return json(res, 400, { error: 'bad project id' });
      if (req.method === 'PUT') { const p = saveProject(id, await readBody(req, 4_000_000)); return json(res, 200, { ok: true, updatedAt: p.updatedAt }); }
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no such project' });
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(file)); return; }
      if (req.method === 'DELETE') { fs.unlinkSync(file); return json(res, 200, { ok: true }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/hold') {
      // Test helper: a response that takes ?ms, so a screenshot tool can wait in real time.
      await new Promise((r) => setTimeout(r, Math.min(20000, Number(url.searchParams.get('ms')) || 0)));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scene') {
      const b = await readBody(req);
      const send = openStream(res);
      const r = await runAgent(res, send, 'illustrator', sceneRequest(b), { charsPerToken: 1.85, useCache: !b.fresh });
      if (r) send(r.done);
      res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/coach') {
      const b = await readBody(req);
      const pack = loadPacks().find((p) => p.id === b.pack);
      if (!pack) { res.writeHead(400); res.end('unknown pack'); return; }
      const send = openStream(res);
      const r = await runAgent(res, send, 'coach', coachRequest(pack, b.text || ''), { useCache: !b.fresh });
      if (r) send(r.done);
      res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/facts') {
      const b = await readBody(req);
      const pack = loadPacks().find((p) => p.id === b.pack);
      if (!pack) { res.writeHead(400); res.end('unknown pack'); return; }
      const checks = (Array.isArray(b.checks) ? b.checks : []).filter((c) => c && c.quote && c.query).slice(0, 3);
      return streamFacts(res, pack, b.text || '', checks);
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const b = await readBody(req);
      const pack = loadPacks().find((p) => p.id === b.pack);
      const ask = String(b.ask || '').trim().slice(0, 400);
      if (!pack || ask.length < 3) { res.writeHead(400); res.end('unknown pack or empty question'); return; }
      return streamAsk(res, pack, b.text || '', ask);
    }
    if (req.method === 'GET') {
      if (url.pathname.startsWith('/vendor/three/')) {
        const f = safeJoin(path.join(ROOT, 'node_modules/three'), url.pathname.slice('/vendor/three/'.length));
        if (f) return sendFile(res, f);
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const f = safeJoin(path.join(ROOT, 'public'), rel);
      if (f) return sendFile(res, f);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message || e));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`story visualiser on :${PORT}, gateway ${GATEWAY}`));
