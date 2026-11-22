// Effects: things that are not solid shapes. Lightning, electricity, sparks, fire, smoke, glow, beams, sparkle,
// rain and snow are drawn as light and particles, not as boxes, and the bright ones light up the scene around them.
// Each effect is an act line ({"t":"act","do":"fire","id":"torch","step":0}), so it enters on its step, loops with
// the scene, can be cut like any other motion, and is drawn the same in every frame of an export: everything here
// is worked out from the scene's own clock and a seed, never from Math.random.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FX = ['lightning', 'electric', 'sparks', 'fire', 'smoke', 'glow', 'beam', 'sparkle', 'rain', 'snow'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// A points sprite of size 1 covers about tan(fov/2) world units; this turns a size in metres into a point size.
const PSZ = 1 / Math.tan((40 / 2) * (Math.PI / 180));

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seeded = (...k) => mulberry(k.reduce((h, v, i) => (h ^ Math.imul((v | 0) + 0x9e3779b9 * (i + 1), 0x85ebca6b)) | 0, 0x2545f491));
const rnd = (...k) => seeded(...k)();
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0; return h >>> 0; }
function col(hex, fallback) {
  const c = new THREE.Color();
  try { c.set(typeof hex === 'string' && /^#?[0-9a-f]{6}$/i.test(hex.trim()) ? '#' + hex.trim().replace('#', '') : fallback); } catch { c.set(fallback); }
  return c;
}

// Soft round dots, a four-pointed star and a puff, drawn once and shared by every stage.
const TEX = {};
export function fxTexture(kind) {
  if (TEX[kind]) return TEX[kind];
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const stops = { puff: [[0, 0.8], [0.45, 0.42], [1, 0]], halo: [[0, 1], [0.16, 0.7], [0.42, 0.2], [1, 0]], star: [[0, 1], [0.12, 0.8], [0.3, 0.12], [1, 0]] }[kind] || [[0, 1], [0.28, 0.85], [0.6, 0.22], [1, 0]];
  for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  if (kind === 'star') {
    for (const [w, h] of [[S, 5], [5, S]]) {
      const lg = w > h ? x.createLinearGradient(0, 0, S, 0) : x.createLinearGradient(0, 0, 0, S);
      lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = lg; x.fillRect((S - w) / 2, (S - h) / 2, w, h);
    }
  }
  const t = new THREE.CanvasTexture(cv); TEX[kind] = t; return t;
}

// Light adds to what is behind it. The canvas is see-through over a painted sky, so the alpha grows a little too,
// or a glow in front of the sky would vanish when the frame is copied for export.
export function glowBlend(m, opacity = 1) {
  return Object.assign(m, {
    transparent: true, depthWrite: false, fog: false, toneMapped: false, opacity,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.SrcAlphaFactor, blendDstAlpha: THREE.OneFactor,
  });
}
const noRay = (o) => { o.traverse((m) => { m.raycast = () => {}; }); return o; };

class Particles {
  constructor(n, size, tex, additive = true) {
    this.n = n; this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ size: size * PSZ, map: fxTexture(tex), vertexColors: true, transparent: true, depthWrite: false, fog: false, sizeAttenuation: true });
    if (additive) glowBlend(mat);
    this.mesh = noRay(new THREE.Points(geo, mat)); this.mesh.frustumCulled = false;
  }
  set(i, x, y, z, r, g, b, a) { this.pos.set([x, y, z], i * 3); this.col.set([r, g, b, clamp(a, 0, 1)], i * 4); }
  flush() { this.mesh.geometry.attributes.position.needsUpdate = true; this.mesh.geometry.attributes.color.needsUpdate = true; }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// A jagged path from A to B: the middle of every segment is pushed sideways, a little less at each level.
function jag(A, B, rand, rough, levels) {
  let pts = [A.clone(), B.clone()]; let amp = A.distanceTo(B) * rough;
  const dir = B.clone().sub(A).normalize(), v = new THREE.Vector3();
  for (let l = 0; l < levels; l++) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const m = pts[i - 1].clone().lerp(pts[i], 0.5);
      v.set(rand() - 0.5, rand() - 0.5, rand() - 0.5); v.addScaledVector(dir, -v.dot(dir)).multiplyScalar(2 * amp);
      out.push(m.add(v), pts[i]);
    }
    pts = out; amp *= 0.52;
  }
  return pts;
}
function tube(pts, r) {
  const path = new THREE.CurvePath(); for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
  return new THREE.TubeGeometry(path, (pts.length - 1) * 2, r, 5, false);
}
// One bolt with a few forks, as three layers: a white-hot core, a coloured glow and a wide faint haze.
function boltLayers(paths, w) {
  return [0.024, 0.075, 0.22].map((r) => {
    const geos = paths.map(([pts, k]) => tube(pts, r * w * k));
    const g = mergeGeometries(geos); geos.forEach((x) => x.dispose()); return g;
  });
}

class Effect {
  constructor(stage, o, key) {
    this.stage = stage; this.o = o; this.seed = strHash(key);
    this.color = stage.styleColor ? stage.styleColor('#' + col(o.color, this.defaultColor || '#ffffff').getHexString()) : col(o.color, this.defaultColor || '#ffffff');
    this.group = new THREE.Group(); this.group.userData.fx = true; this.group.visible = false;
    stage.root.add(this.group);
  }
  // Size of the effect: given by "s", or taken from the thing it is on.
  scaleFor(target, base = 1) { return clamp(num(this.o.s, target?.box ? clamp(Math.max(target.size.x, target.size.z) * 0.75, 0.35, 3) : 1) * base, 0.15, 6); }
  dispose() { this.group.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }); }
}

class Lightning extends Effect {
  get defaultColor() { return '#9fd8ff'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.layers = [new THREE.Color('#ffffff'), this.color, this.color].map((c, i) => noRay(new THREE.Mesh(new THREE.BufferGeometry(), glowBlend(new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }), [1, 0.6, 0.2][i]))));
    this.layers.forEach((m) => this.group.add(m)); this.built = null;
    this.P = clamp(num(o.dur, 1.7), 0.5, 6); this.n = clamp(Math.round(num(o.n, 1)), 1, 4); this.w = clamp(num(o.w, 1), 0.3, 4);
  }
  update(f) {
    const S = this.stage, end = S.fxPoint(this.o.to ?? this.o.id ?? this.o.at, 'top');
    if (!end || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    const cyc = Math.floor(f.live / this.P), ph = f.live - cyc * this.P;
    // A strike flickers: a bolt, a blink of dark, a second bolt on a new path that fades out.
    const on = ph < 0.09 || (ph > 0.13 && ph < 0.42);
    this.group.visible = on;
    if (!on) return;
    const sub = ph < 0.11 ? 0 : 1, k = sub ? 1 - ((ph - 0.13) / 0.29) * 0.75 : 1;
    const sig = `${cyc}|${sub}|${end.x.toFixed(2)}|${end.y.toFixed(2)}|${end.z.toFixed(2)}`;
    if (sig !== this.built) {
      this.built = sig; const paths = [];
      for (let b = 0; b < this.n; b++) {
        const r = seeded(this.seed, cyc, sub, b);
        const start = this.o.from != null ? S.fxPoint(this.o.from, 'top') : null;
        const A = start ? new THREE.Vector3(start.x, start.y, start.z) : new THREE.Vector3(end.x + (r() - 0.5) * 5, end.y + 9 + r() * 2, end.z - 1 - r() * 2);
        const B = new THREE.Vector3(end.x + (b ? (r() - 0.5) * 0.8 : 0), end.y, end.z + (b ? (r() - 0.5) * 0.8 : 0));
        const main = jag(A, B, r, 0.17, 5); paths.push([main, b ? 0.75 : 1]);
        for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
          const at = 6 + Math.floor(r() * (main.length * 0.6)), P0 = main[Math.min(at, main.length - 2)];
          const len = A.distanceTo(B) * (0.12 + r() * 0.18), d = B.clone().sub(A).normalize();
          const P1 = P0.clone().add(new THREE.Vector3((r() - 0.5) * 2, 0, (r() - 0.5) * 2).add(d).normalize().multiplyScalar(len));
          paths.push([jag(P0, P1, r, 0.2, 4), 0.5]);
        }
      }
      boltLayers(paths, this.w).forEach((g, i) => { this.layers[i].geometry.dispose(); this.layers[i].geometry = g; });
    }
    this.layers.forEach((m, i) => { m.material.opacity = [1, 0.6, 0.2][i] * k; });
    S.fxLight(end.x, end.y + 1, end.z, this.color, 90 * k * this.w); S.fxFlash(0.9 * k);
  }
}

// Triangles of an object's visible parts in world space, weighted by area, to pick points on its surface.
function surfaceOf(g) {
  const tris = []; let total = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  g.updateWorldMatrix(true, true);
  for (const m of g.children) {
    if (!m.isMesh || m.isInstancedMesh || m.userData.halo || !m.geometry?.attributes.position) continue;
    const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
    const step = Math.max(3, Math.floor(n / 3 / 60) * 3); // a sample of at most ~60 triangles per part
    for (let i = 0; i + 2 < n; i += step) {
      const [i0, i1, i2] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2; if (area < 1e-5) continue;
      total += area; tris.push([a.clone(), b.clone(), c.clone(), total]);
    }
  }
  return tris.length ? { tris, total } : null;
}
function pickOnSurface({ tris, total }, r) {
  const x = r() * total; const t = tris.find((q) => q[3] >= x) || tris[tris.length - 1];
  let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
  return t[0].clone().addScaledVector(t[1].clone().sub(t[0]), u).addScaledVector(t[2].clone().sub(t[0]), v);
}

class Electric extends Effect {
  get defaultColor() { return '#7df9ff'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.layers = [new THREE.Color('#ffffff'), this.color, this.color].map((c, i) => noRay(new THREE.Mesh(new THREE.BufferGeometry(), glowBlend(new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }), [1, 0.65, 0.22][i]))));
    this.layers.forEach((m) => this.group.add(m)); this.built = null; this.n = clamp(Math.round(num(o.n, 3)), 1, 6);
  }
  update(f) {
    const T = this.stage.fxTarget(this.o.id ?? this.o.at);
    if (!T || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    const tick = Math.floor(f.live / 0.07), on = rnd(this.seed, tick, 7) > 0.18;
    this.group.visible = on; if (!on) return;
    const sig = `${tick}|${T.c.x.toFixed(2)}|${T.c.y.toFixed(2)}|${T.c.z.toFixed(2)}|${T.size.y.toFixed(2)}`;
    if (sig !== this.built) {
      this.built = sig; const paths = [], r = seeded(this.seed, tick), s = T.size, b = T.box, big = Math.max(s.x, s.y, s.z, 0.4);
      // Arcs crawl over the surface of the thing, from one spot on it to a nearby one.
      // Arcs crawl over the thing's own faces, from one spot on it to another spot near it.
      const onBox = () => {
        const p = new THREE.Vector3(b.min.x + r() * s.x, b.min.y + r() * s.y, b.min.z + r() * s.z), axis = Math.floor(r() * 3), side = r() < 0.5 ? 'min' : 'max';
        p.setComponent(axis, b[side].getComponent(axis)); return p;
      };
      const tris = T.g ? surfaceOf(T.g) : null;
      const onSurface = () => (tris ? pickOnSurface(tris, r) : onBox());
      for (let i = 0, n = this.o.n != null ? this.n : clamp(Math.round(2 + big / 1.5), 3, 6); i < n; i++) {
        const A = onSurface(); let B = onSurface();
        for (let k = 0; k < 4 && A.distanceTo(B) > big * 0.6; k++) B = onSurface();
        if (A.distanceTo(B) < big * 0.12) B.add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(big * 0.3));
        paths.push([jag(A, B, r, 0.3, 4), 0.42]);
      }
      boltLayers(paths, clamp(num(this.o.w, 1), 0.3, 3)).forEach((g, i) => { this.layers[i].geometry.dispose(); this.layers[i].geometry = g; });
    }
    const k = clamp(f.live / 0.3, 0, 1) * (1 - f.rw);
    this.layers.forEach((m, i) => { m.material.opacity = [1, 0.65, 0.22][i] * k; });
    this.stage.fxLight(T.c.x, T.c.y, T.c.z, this.color, 14 * k);
  }
}

class Sparks extends Effect {
  get defaultColor() { return '#ffd36b'; }
  constructor(stage, o, key) { super(stage, o, key); this.N = 70; this.p = new Particles(this.N, 0.14, 'dot'); this.group.add(this.p.mesh); }
  update(f) {
    const o = this.stage.fxPoint(this.o.id ?? this.o.at, 'top'), T = this.o.id != null ? this.stage.fxTarget(this.o.id) : null;
    if (!o || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const s = this.scaleFor(T, 0.8), L = 0.85, fade = clamp(f.live / 0.2, 0, 1) * (1 - f.rw), c = this.color;
    for (let i = 0; i < this.N; i++) {
      const ph = f.live + (i * L) / this.N, born = Math.floor(ph / L), a = ph - born * L, u = a / L;
      if (f.live - a < 0) { this.p.set(i, 0, -50, 0, 0, 0, 0, 0); continue; }
      const r = seeded(this.seed, i, born), th = r() * Math.PI * 2, up = 0.3 + 0.7 * r(), sp = (2.2 + 3.2 * r()) * s, side = Math.sqrt(1 - up * up);
      const y = Math.max(0.03, o.y + up * sp * a - 4.9 * a * a);
      const hot = 1 - u;
      this.p.set(i, o.x + Math.cos(th) * side * sp * a, y, o.z + Math.sin(th) * side * sp * a, 1, c.g * (0.6 + 0.4 * hot), c.b * hot * hot + 0.2 * hot, hot * fade);
    }
    this.p.flush();
    this.stage.fxLight(o.x, o.y + 0.4, o.z, this.color, 10 * s * fade * (0.75 + 0.25 * Math.sin(f.live * 31)));
  }
}

class Fire extends Effect {
  get defaultColor() { return '#ff7a1a'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.s0 = null; this.core = null; this.glow = null;
  }
  build(s) {
    this.s0 = s;
    for (const p of [this.core, this.glow]) if (p) { this.group.remove(p.mesh); p.dispose(); }
    this.core = new Particles(80, 0.42 * s, 'dot'); this.glow = new Particles(22, 1.3 * s, 'halo');
    this.group.add(this.glow.mesh, this.core.mesh);
  }
  update(f) {
    const o = this.stage.fxPoint(this.o.id ?? this.o.at, 'top'), T = this.o.id != null ? this.stage.fxTarget(this.o.id) : null;
    if (!o || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const s = Math.round(this.scaleFor(T) * 10) / 10; if (s !== this.s0) this.build(s);
    const fade = clamp(f.live / 0.4, 0, 1) * (1 - f.rw), c = this.color, y0 = o.y - 0.08 * s;
    // Flames: born at the base, they rise, narrow and cool from white-yellow through the fire's colour to dark red.
    const flame = (p, L, rise, spread, alpha) => {
      for (let i = 0; i < p.n; i++) {
        const ph = f.live + (i * L) / p.n, born = Math.floor(ph / L), a = ph - born * L, u = a / L, r = seeded(this.seed, i, born, p.n);
        const r1 = r() - 0.5, r2 = r() - 0.5, h = rise * (0.6 + 0.6 * r()), wob = Math.sin(f.live * 9 + i * 1.7) * 0.07 * s * u;
        const w = spread * s * (1 - u * 0.85);
        const t1 = clamp(u / 0.35, 0, 1), t2 = clamp((u - 0.35) / 0.65, 0, 1);
        const R = 1 * (1 - t2) + 0.75 * t2, G = (0.92 * (1 - t1) + c.g * t1) * (1 - t2) + 0.12 * t2, B = (0.6 * (1 - t1) + c.b * t1) * (1 - t2);
        p.set(i, o.x + r1 * w + wob, y0 + u * h * s, o.z + r2 * w, R, G, B, alpha * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8 * fade);
      }
      p.flush();
    };
    flame(this.core, 0.8, 1.5, 0.55, 0.9); flame(this.glow, 1.1, 1.1, 0.35, 0.33);
    const flick = 0.8 + 0.2 * Math.sin(f.live * 23) * Math.sin(f.live * 7.3 + 1);
    this.stage.fxLight(o.x, y0 + 0.6 * s, o.z, this.color, 16 * s * flick * fade);
  }
}

class Smoke extends Effect {
  get defaultColor() { return '#8d929b'; }
  constructor(stage, o, key) { super(stage, o, key); this.s0 = null; this.p = null; }
  update(f) {
    const o = this.stage.fxPoint(this.o.id ?? this.o.at, 'top'), T = this.o.id != null ? this.stage.fxTarget(this.o.id) : null;
    if (!o || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const s = Math.round(this.scaleFor(T) * 10) / 10;
    if (s !== this.s0) { this.s0 = s; if (this.p) { this.group.remove(this.p.mesh); this.p.dispose(); } this.p = new Particles(30, 1.25 * s, 'puff', false); this.group.add(this.p.mesh); }
    const L = 3.4, fade = clamp(f.live / 0.6, 0, 1) * (1 - f.rw), c = this.color;
    for (let i = 0; i < this.p.n; i++) {
      const ph = f.live + (i * L) / this.p.n, born = Math.floor(ph / L), a = ph - born * L, u = a / L, r = seeded(this.seed, i, born);
      if (f.live - a < 0) { this.p.set(i, 0, -50, 0, 0, 0, 0, 0); continue; }
      const sh = 0.85 + 0.3 * r();
      this.p.set(i, o.x + (r() - 0.5) * 0.4 * s + u * u * 1.3 * s + Math.sin(f.live * 1.3 + i) * 0.15 * s * u, o.y + u * 3.6 * s, o.z + (r() - 0.5) * 0.4 * s,
        c.r * sh, c.g * sh, c.b * sh, 0.55 * Math.sin(Math.PI * u) ** 0.7 * fade);
    }
    this.p.flush();
  }
}

class Glow extends Effect {
  get defaultColor() { return '#ffd24a'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.sp = noRay(new THREE.Sprite(glowBlend(new THREE.SpriteMaterial({ map: fxTexture('halo'), color: this.color }), 0.7)));
    this.group.add(this.sp);
  }
  update(f) {
    const T = this.stage.fxTarget(this.o.id ?? this.o.at);
    if (!T || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const k = clamp(f.live / 0.5, 0, 1) * (1 - f.rw), pulse = 1 + 0.08 * Math.sin(f.live * 3.2), big = clamp(Math.max(T.size.x, T.size.y, T.size.z), 0.5, 10);
    this.sp.position.copy(T.c); this.sp.scale.setScalar(big * 2 * clamp(num(this.o.s, 1), 0.3, 3) * pulse * (0.6 + 0.4 * k));
    this.sp.material.opacity = 0.7 * k;
    this.stage.fxLight(T.c.x, T.c.y, T.c.z, this.color, 5 * Math.min(big, 2.5) * k * pulse);
  }
}

class Beam extends Effect {
  get defaultColor() { return '#5ff2ff'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.w = clamp(num(o.w, 0.2), 0.03, 4); const spread = clamp(num(o.spread, 1), 0.2, 12);
    const geo = new THREE.CylinderGeometry(spread * 0.5, 0.5, 1, 24, 1, true); geo.translate(0, 0.5, 0);
    this.layers = [[new THREE.Color('#ffffff'), 0.28, 0.95], [this.color, 1, 0.5], [this.color, 1.9, 0.1]].map(([c, w, op]) => {
      const m = noRay(new THREE.Mesh(geo, glowBlend(new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }), op))); m.userData.w = w; m.userData.op = op; this.group.add(m); return m;
    });
    this.end = noRay(new THREE.Sprite(glowBlend(new THREE.SpriteMaterial({ map: fxTexture('halo'), color: this.color }), 0.8))); this.group.add(this.end);
    this.q = new THREE.Quaternion();
  }
  update(f) {
    const A = this.stage.fxPoint(this.o.from ?? this.o.id, 'upper'), B = this.stage.fxPoint(this.o.to, 'center');
    if (!A || !B || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const a = new THREE.Vector3(A.x, A.y, A.z), d = new THREE.Vector3(B.x, B.y, B.z).sub(a), len = d.length() || 0.01, k = clamp(f.live / 0.35, 0, 1) * (1 - f.rw);
    this.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    const shimmer = 1 + 0.06 * Math.sin(f.live * 40);
    for (const m of this.layers) { m.position.copy(a); m.quaternion.copy(this.q); m.scale.set(this.w * m.userData.w * shimmer, len * k, this.w * m.userData.w * shimmer); m.material.opacity = m.userData.op * (k > 0 ? 1 : 0); }
    this.end.position.copy(a).addScaledVector(d, k); this.end.scale.setScalar(this.w * 4 * shimmer * clamp(num(this.o.spread, 1), 1, 6)); this.end.visible = k > 0.95;
    this.stage.fxLight(this.end.position.x, this.end.position.y, this.end.position.z, this.color, 12 * this.w * 4 * k);
  }
}

class Sparkle extends Effect {
  get defaultColor() { return '#fff3b0'; }
  constructor(stage, o, key) { super(stage, o, key); this.p = new Particles(20, 0.55, 'star'); this.group.add(this.p.mesh); }
  update(f) {
    const T = this.stage.fxTarget(this.o.id ?? this.o.at);
    if (!T || f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const fade = clamp(f.live / 0.4, 0, 1) * (1 - f.rw), c = this.color, b = T.box, s = T.size;
    for (let i = 0; i < this.p.n; i++) {
      const r = seeded(this.seed, i), sp = 0.7 + r() * 0.8, ph = r();
      const tw = Math.max(0, Math.sin(Math.PI * 2 * (f.live * sp + ph))) ** 5;
      this.p.set(i, b.min.x - 0.15 * s.x + r() * s.x * 1.3, b.min.y + r() * s.y * 1.2, b.min.z - 0.15 * s.z + r() * s.z * 1.3, c.r, c.g, c.b, tw * fade);
    }
    this.p.flush();
  }
}

class Weather extends Effect {
  get defaultColor() { return this.o.do === 'snow' ? '#ffffff' : '#b7cdf2'; }
  constructor(stage, o, key) {
    super(stage, o, key);
    this.snow = o.do === 'snow'; this.N = this.snow ? 450 : 650;
    if (this.snow) { this.p = new Particles(this.N, 0.13, 'puff', false); this.group.add(this.p.mesh); }
    else {
      this.pos = new Float32Array(this.N * 6); const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.lines = noRay(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.5, depthWrite: false }))); this.lines.frustumCulled = false; this.group.add(this.lines);
    }
  }
  update(f) {
    if (f.live < 0 || f.rw >= 1) { this.group.visible = false; return; }
    this.group.visible = true;
    const fade = clamp(f.live / 0.6, 0, 1) * (1 - f.rw), H = 12, cx = this.stage.cam.x, cz = this.stage.cam.z, heavy = clamp(num(this.o.n, 1), 0.3, 1);
    for (let i = 0; i < this.N; i++) {
      const r = seeded(this.seed, i), x = cx + (r() - 0.5) * 24, z = cz + (r() - 0.5) * 18 - 1, show = r() < heavy;
      if (this.snow) {
        const sp = 0.8 + 0.6 * r(), y = H - ((f.live * sp + r() * H) % H);
        this.p.set(i, x + Math.sin(f.live * 0.9 + i) * 0.35, y, z + Math.cos(f.live * 0.7 + i) * 0.25, 1, 1, 1, show ? 0.9 * fade : 0);
      } else {
        const sp = 13 + 5 * r(), y = show ? H - ((f.live * sp + r() * H) % H) : -50;
        this.pos.set([x, y, z, x + 0.06, y + 0.5, z], i * 6);
      }
    }
    if (this.snow) this.p.flush();
    else { this.lines.geometry.attributes.position.needsUpdate = true; this.lines.material.opacity = 0.5 * fade; }
  }
}

const KINDS = { lightning: Lightning, electric: Electric, sparks: Sparks, fire: Fire, smoke: Smoke, glow: Glow, beam: Beam, sparkle: Sparkle, rain: Weather, snow: Weather };
export function makeFx(stage, o, key) { const K = KINDS[o.do]; return K ? new K(stage, o, key) : null; }
