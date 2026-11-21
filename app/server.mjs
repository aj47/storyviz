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

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 400_000) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Stream one agent turn from the OpenClaw gateway and forward complete lines as SSE.
async function streamAgent(req, res, agent, userText, maxTokens, charsPerToken, useCache = true) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  // Identical requests replay from disk, clearly marked as cached, so reloads and retakes are instant.
  const cacheFile = path.join(CACHE, crypto.createHash('sha1').update(agent + '\n' + userText).digest('hex') + '.json');
  if (useCache && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      send({ type: 'first', waitMs: 0, cached: true });
      for (const raw of c.lines) { send({ type: 'line', raw, ms: 0 }); await new Promise((r) => setTimeout(r, 25)); }
      send({ ...c.done, cached: true }); res.end(); return;
    } catch { /* fall through to a live run */ }
  }
  const kept = [];
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const t0 = Date.now();
  let first = 0, chars = 0, buf = '', lines = 0, usage = null;
  const beat = setInterval(() => { if (!first) send({ type: 'wait', ms: Date.now() - t0 }); }, 1000);
  const emitLine = (line) => {
    line = line.trim();
    if (!line || line.startsWith('```')) return;
    lines++; kept.push(line);
    send({ type: 'line', raw: line, ms: Date.now() - t0 });
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
      type: 'done', waitMs: first ? first - t0 : Date.now() - t0, genMs, chars, lines, tokens, totalTokens: total,
      tps: genMs > 0 ? Math.round(tokens / (genMs / 1000)) : 0,
    };
    send(done);
    const cutOff = total >= maxTokens * 0.98;
    if (lines >= 2 && !cutOff) fs.writeFile(cacheFile, JSON.stringify({ agent, lines: kept, done }), () => {});
  } catch (e) {
    if (!ac.signal.aborted) send({ type: 'error', message: String(e.message || e) });
  } finally {
    clearInterval(beat);
    res.end();
  }
}

function sceneRequest(b) {
  const mode = ['diorama', 'storyboard', 'diagram'].includes(b.mode) ? b.mode : 'diorama';
  const parts = [`mode: ${mode}`, `strict: ${b.strict ? 'yes' : 'no'}`];
  if (b.kind) parts.push(`writing type: ${String(b.kind).slice(0, 60)}`);
  if (b.index != null) parts.push(`paragraph number: ${Number(b.index) + 1} of ${Number(b.total) || 1}`);
  if (b.context) parts.push(`earlier paragraphs (for continuity only, do not draw them):\n${String(b.context).slice(-1500)}`);
  if (b.cast) parts.push(`cast from the previous scene (reuse an obj line unchanged if the same thing appears again):\n${String(b.cast).slice(0, 3500)}`);
  parts.push(`paragraph to draw:\n"""\n${String(b.paragraph || '').slice(0, 2500)}\n"""`);
  return parts.join('\n\n');
}

function coachRequest(pack, text) {
  const slim = {
    type: pack.name,
    structure: pack.structure,
    sources: pack.sources.map((s) => ({ id: s.id, title: s.title })),
    rules: pack.rules.map((r) => ({ id: r.id, name: r.name, rule: r.rule, look_for: r.look_for })),
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
    if (req.method === 'GET' && url.pathname === '/api/hold') {
      // Test helper: a response that takes ?ms, so a screenshot tool can wait in real time.
      await new Promise((r) => setTimeout(r, Math.min(20000, Number(url.searchParams.get('ms')) || 0)));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scene') {
      const b = await readBody(req);
      return streamAgent(req, res, 'illustrator', sceneRequest(b), 6000, 1.85, !b.fresh);
    }
    if (req.method === 'POST' && url.pathname === '/api/coach') {
      const b = await readBody(req);
      const pack = loadPacks().find((p) => p.id === b.pack);
      if (!pack) { res.writeHead(400); res.end('unknown pack'); return; }
      return streamAgent(req, res, 'coach', coachRequest(pack, b.text || ''), 6000, 3.4, !b.fresh);
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
