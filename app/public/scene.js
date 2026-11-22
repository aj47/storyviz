// 3D stage: draws scene lines (env, obj, many, label, gap, node, edge, shot, act, count) the moment
// they arrive, in whichever visual style is active. Restyling rebuilds from the stored lines.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FX, makeFx, fxTexture, glowBlend } from './fx.js';

const D2R = Math.PI / 180;
const GHOST = '#c9ced8';

export const STYLES = {
  clay: { label: 'Clay', seg: 'hi', shade: 'standard', rough: 1, tint: 0.14 },
  lowpoly: { label: 'Low-poly', seg: 'lo', shade: 'flat' },
  toon: { label: 'Toon', seg: 'hi', shade: 'toon', outline: true, sat: 0.25 },
  voxel: { label: 'Voxel', seg: 'lo', shade: 'standard', rough: 0.85, voxel: true },
  neon: { label: 'Neon', seg: 'lo', shade: 'lines', fill: '#05060c', fillOpacity: 1, glow: true,
    sky: ['#010208', '#12072b'], ground: '#04050b', grid: ['#00e5ff', '#3b1d7a'] },
  blueprint: { label: 'Blueprint', seg: 'lo', shade: 'lines', fill: '#1c5fc0', fillOpacity: 0.22, line: '#eaf2ff',
    sky: ['#082a63', '#1553ad'], ground: '#0c3a86', grid: ['#9cc2ff', '#3f77cf'] },
};
export const STYLE_ORDER = ['clay', 'lowpoly', 'toon', 'voxel', 'neon', 'blueprint'];

const CAMS = {
  wide: { r: 17, phi: 70, y: 1.6, x: 0, z: 0 }, diagram: { r: 21, phi: 48, y: 0.4, x: 0, z: 0 },
};
const SHOT_ZOOM = { wide: 1.5, medium: 1.05, close: 0.72, low: 1.05, top: 1.25 };
const SHOT_PHI = { low: 86, top: 26 };

const NODE_KINDS = {
  service: { h: 1.3, parts: [['box', [0, 0.65, 0], [2.4, 1.3, 1.6], '#4f8cff']] },
  db: { h: 1.7, parts: [['cyl', [0, 0.85, 0], [1.9, 1.7, 1.9], '#2fbf71'], ['cyl', [0, 1.72, 0], [2.0, 0.12, 2.0], '#7fe0a8']] },
  queue: { h: 0.9, parts: [['box', [-0.9, 0.45, 0], [0.75, 0.9, 1.3], '#ff9f43'], ['box', [0, 0.45, 0], [0.75, 0.9, 1.3], '#ffb866'], ['box', [0.9, 0.45, 0], [0.75, 0.9, 1.3], '#ffd08f']] },
  worker: { h: 1.9, parts: [['box', [0, 0.7, 0], [1.8, 1.4, 1.5], '#9b6dff'], ['torus', [0, 1.65, 0], [1.1, 0.3, 1.1], '#d3c2ff']] },
  user: { h: 2.1, parts: [['cyl', [0, 0.6, 0], [0.9, 1.2, 0.9], '#ff6fa3'], ['sphere', [0, 1.6, 0], [0.8, 0.8, 0.8], '#ffd2b3']] },
  file: { h: 1.9, parts: [['box', [0, 0.95, 0], [1.4, 1.9, 0.18], '#f1f3f8', [-12, 0, 0]], ['box', [0, 1.35, 0.12], [0.9, 0.1, 0.04], '#8a93a6', [-12, 0, 0]], ['box', [0, 1.05, 0.12], [0.9, 0.1, 0.04], '#8a93a6', [-12, 0, 0]]] },
  cloud: { h: 1.9, parts: [['sphere', [-0.7, 1.0, 0], [1.4, 1.2, 1.3], '#bfe3ff'], ['sphere', [0.2, 1.25, 0], [1.7, 1.5, 1.5], '#d9efff'], ['sphere', [1.0, 0.95, 0], [1.2, 1.0, 1.2], '#bfe3ff']] },
  step: { h: 0.5, parts: [['cyl', [0, 0.25, 0], [2.3, 0.5, 2.3], '#21c7b7']] },
  concept: { h: 1.7, parts: [['sphere', [0, 0.85, 0], [1.7, 1.7, 1.7], '#ffd24a']] },
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const easeOut = (k) => 1 - (1 - k) ** 3;
const bounce = (k) => { const n = 7.5625, d = 2.75; if (k < 1 / d) return n * k * k; if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75; if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375; return n * (k -= 2.625 / d) * k + 0.984375; };
const ENTERS = ['pop', 'drop', 'grow', 'left', 'right'];
const ACTS = ['move', 'flow', 'grow', 'rise', 'shake', 'vanish', 'spin', 'flash', 'look', ...FX];
export { FX };
const SHAPES = ['box', 'sphere', 'cyl', 'cone', 'torus', 'pyramid', 'wedge', 'dome', 'capsule'];
const FINISHES = ['glow', 'metal', 'glass'];
// A part's finish is its last element when that is a word: [shape, centre, size, colour, rotation?, finish?].
const finishOf = (p) => { const f = typeof p[5] === 'string' ? p[5] : typeof p[4] === 'string' ? p[4] : null; return FINISHES.includes(f) ? f : null; };
// Two act lines are the same motion when they do the same thing to the same object in the same step.
// An effect with no object of its own is told apart by where it is.
export const actKey = (o) => (o.t === 'count' ? `count|${JSON.stringify(o.at)}|${o.step || 0}` : `${o.do}|${o.id ?? ''}|${o.of ?? ''}|${JSON.stringify(o.from ?? '')}|${o.step || 0}` + (FX.includes(o.do) && o.at != null && o.id == null ? `|${JSON.stringify(o.at)}` : ''));
const easeOutBack = (k) => { const c = 1.9; const x = clamp(k, 0, 1) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };

function color(hex, fallback = '#b8bcc6') {
  const c = new THREE.Color();
  try { c.set(typeof hex === 'string' && /^#?[0-9a-f]{3,8}$/i.test(hex.trim()) ? (hex.trim().startsWith('#') ? hex.trim().slice(0, 7) : '#' + hex.trim().slice(0, 6)) : fallback); }
  catch { c.set(fallback); }
  return c;
}

function toonGradient() {
  const data = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  return tex;
}

export class Stage {
  // opts.size = [w, h] makes an offscreen stage for export: a fixed size in pixels, no mouse, and no clock of
  // its own. Its owner moves time forward with renderAt(ms), so a frame is the same however long it takes to draw.
  constructor(container, hooks = {}, opts = {}) {
    this.container = container; this.hooks = hooks; this.fixed = opts.size || null; this.vnow = null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(this.fixed ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.0); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 60 });
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    // Fire, lightning and glowing parts light what is around them. A fixed set of lights is shared out every frame
    // to the brightest of them, so adding one never makes every material recompile.
    this.fxLights = Array.from({ length: 4 }, () => { const l = new THREE.PointLight(0xffffff, 0, 16, 2); this.scene.add(l); return l; });
    this.lightReq = []; this.flashK = 0; this.hemiBase = 1; this.sunBase = 2.2;
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(60, 72), new THREE.MeshStandardMaterial({ color: 0x9aa39a, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(60, 60, 0xffffff, 0xffffff); this.grid.position.y = 0.01; this.grid.visible = false; this.scene.add(this.grid);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.diagram = new THREE.Group(); this.root.add(this.diagram);
    this.toonMap = toonGradient();
    this.geoCache = new Map(); this.edgeCache = new Map(); this.matCache = new Map();
    this.styleName = 'clay'; this.style = STYLES.clay;
    this.lines = []; this.mode = 'diorama';
    this.cam = { ...CAMS.wide }; this.camT = { ...CAMS.wide }; this.userTheta = 0; this.userPhi = 0; this.zoom = 1; this.lastTouch = 0;
    this._resetState();
    this._applyEnv({});
    this.lenSec = 0; this.playing = false; this.lastNow = null;
    if (this.fixed) { this._resize(); return; }
    this._bindPointer();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }
  _now() { return this.vnow ?? performance.now(); }

  // ---------- public ----------
  setMode(mode) { this.mode = mode; this.shotCam = null; this.camT = { ...(mode === 'diagram' ? CAMS.diagram : CAMS.wide) }; }
  setStyle(name) {
    if (!STYLES[name]) return;
    this.styleName = name; this.style = STYLES[name];
    this.matCache.clear();
    const lines = this.lines, tl0 = this.tl0; this._clearObjects(); this.lines = [];
    this._applyEnv(this.env || {});
    for (const l of lines) this.addLine(l, false);
    this.tl0 = tl0; // a new style keeps the story where it was
  }
  clear() { this._clearObjects(); this.lines = []; this.env = null; this._applyEnv({}); this.setMode(this.mode); }
  load(lines, pop = false) { this.clear(); lines.forEach((l, i) => this.addLine(l, pop, i * 45)); }
  get objectCount() { return this.count; }
  // How long the scene lasts on screen, in seconds. The story's steps are spread over it, and the preview loops at
  // that length, so trimming a scene shows straight away what fits. 0 goes back to the pace the illustrator set.
  setLength(sec) { const v = clamp(num(sec), 0, 60); if (v !== this.lenSec) { this.lenSec = v; this.tl0 = this._now(); } }
  restart() { this.tl0 = this._now(); }
  // The sky is painted behind the canvas, so an exported frame needs its colours.
  get sky() { return this.skyCols || ['#8ec5ff', '#eaf4ff']; }
  // Export: build a scene with everything already in place (stepped things still enter on cue), play it once
  // from the start without the wind-back at the end of a loop, and render the frame at a given time.
  loadForExport(lines, sec) {
    this.vnow = 0; this.playing = true; this.clear(); this.lenSec = clamp(num(sec), 0.5, 60);
    lines.forEach((l) => this.addLine(l, false));
    this.tl0 = 0; this.cam = { ...this.camT }; this.lastNow = null;
    // Settle what must be see-through before the first frame, so nothing fades in a second into the scene.
    for (let i = 0; i < 2; i++) { this.lastReveal = -1e9; this.renderAt(0); }
    this.lastNow = null;
  }
  renderAt(ms) { this.vnow = ms; this._frame(); return this.renderer.domElement; }

  // Apply a line from an improvement pass: an obj with a known id replaces that object where it
  // stands, a new env replaces the old one, and anything else is added.
  upsert(o, pop = true) {
    if (!o || typeof o !== 'object') return;
    const id = o.t === 'obj' && o.id != null ? String(o.id) : null;
    const motion = o.t === 'act' || o.t === 'count';
    const at = id && this.groups.has(id) ? this.lines.findIndex((l) => l.t === 'obj' && String(l.id) === id)
      : o.t === 'env' || o.t === 'shot' ? this.lines.findIndex((l) => l.t === o.t)
      : motion ? this.lines.findIndex((l) => l.t === o.t && actKey(l) === actKey(o)) : -1;
    if (id && this.groups.has(id)) this._remove([this.groups.get(id)]);
    if (motion && at >= 0) this._dropMotion((m) => m.key === actKey(o));
    this.addLine(o, pop);
    // Keep the line in its old place, so a later restyle still meets each obj before the many that repeats it.
    if (at >= 0) { this.lines.pop(); this.lines[at] = o; }
  }

  addLine(o, pop = true, delay = 0) {
    if (!o || typeof o !== 'object') return;
    this.lines.push(o);
    try {
      switch (o.t) {
        case 'env': this.env = o; this._applyEnv(o); this.hooks.onTitle?.(o.title || ''); break;
        case 'obj': if (o.id) this.defs.set(String(o.id), o); this._addObj(o, pop, delay); break;
        case 'many': this._addMany(o, pop, delay); break;
        case 'label': this._addLabel(o); break;
        case 'gap': this._addGap(o, pop, delay); break;
        case 'node': this._addNode(o, pop, delay); break;
        case 'edge': this._addEdge(o); break;
        case 'act': this._addAct(o, pop); break;
        case 'count': this._addCount(o, pop); break;
        case 'shot': this.shotSec = num(o.sec); this.shotCam = o.cam || 'medium'; this._reframe(); this.hooks.onShot?.(o); break;
        default: break;
      }
    } catch (e) { console.warn('bad scene line', o, e); }
  }

  // Take an object, and every copy a many line made of it, off the stage.
  drop(id) {
    id = String(id);
    this._remove([this.groups.get(id), ...(this.copies.get(id) || [])].filter(Boolean));
    this.groups.delete(id); this.copies.delete(id); this.defs.delete(id);
    const uses = (l) => l.t === 'act' && [l.id, l.of, l.from, l.to].some((r) => typeof r === 'string' && r === id);
    this._dropMotion((m) => uses(m.o));
    this.lines = this.lines.filter((l) => !((l.t === 'obj' && String(l.id) === id) || (l.t === 'many' && String(l.of) === id) || uses(l)));
  }
  // Take one motion (an act or a count) out of the scene.
  dropAct(key) {
    this._dropMotion((m) => m.key === key);
    this.lines = this.lines.filter((l) => !((l.t === 'act' || l.t === 'count') && actKey(l) === key));
  }
  _remove(groups) {
    for (const g of groups) g.parent?.remove(g);
    this.actors = this.actors.filter((a) => !groups.includes(a.g));
  }
  _dropMotion(test) {
    for (const m of [...this.acts, ...this.counts]) if (test(m)) { (m.parts || [m.ring, m.sp]).forEach((x) => x?.parent?.remove(x)); m.fx?.dispose(); if (m.tx) this.texts = this.texts.filter((t) => t !== m.tx); }
    this.acts = this.acts.filter((m) => !test(m)); this.counts = this.counts.filter((m) => !test(m));
  }

  // ---------- internals ----------
  _resetState() {
    this.defs = new Map(); this.groups = new Map(); this.copies = new Map(); this.nodes = new Map(); this.pendingEdges = [];
    this.actors = []; this.acts = []; this.counts = []; this.texts = []; this.maxStep = 0; this.tl0 = this._now(); this.shotSec = 0; this.lookNow = undefined;
    this.pulses = []; this.disposables = []; this.count = 0;
    this.focusBox = new THREE.Box3(); this.focusN = 0; this.shotCam = null;
    this.faded = new Set(); this.hiddenOnce = new Set(); this.lastReveal = -1e9;
    this.diagramTarget = new THREE.Vector3();
  }
  _clearObjects() {
    for (const d of this.disposables) d.dispose?.();
    const drop = (g) => { while (g.children.length) g.remove(g.children[0]); };
    drop(this.diagram); drop(this.root); this.root.add(this.diagram); this.diagram.position.set(0, 0, 0);
    this._resetState();
  }

  _applyEnv(o) {
    const st = this.style;
    const sky = st.sky || (Array.isArray(o.sky) && o.sky.length >= 2 ? o.sky : ['#8ec5ff', '#eaf4ff']);
    const top = color(sky[0], '#8ec5ff'), hor = color(sky[1], '#eaf4ff');
    this.skyCols = ['#' + top.getHexString(), '#' + hor.getHexString()];
    this.container.style.background = `linear-gradient(${this.skyCols[0]} 0%, ${this.skyCols[1]} 62%, ${this.skyCols[1]} 100%)`;
    const fog = clamp(num(o.fog, 0.3), 0, 1);
    this.scene.fog = new THREE.Fog(hor, 26 - fog * 12, 78 - fog * 34);
    this.ground.material.color.copy(color(st.ground || o.ground, '#9fb59a'));
    this.ground.material.needsUpdate = true;
    this.bgLum = hor.getHSL({}).l;
    const lines = st.shade === 'lines';
    this.grid.visible = lines || this.mode === 'diagram';
    if (this.grid.visible) {
      const [c1, c2] = st.grid || (this.bgLum > 0.55 ? ['#5c6475', '#8b93a3'] : ['#c9d3ea', '#6f7a94']);
      this.scene.remove(this.grid); this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(60, 60, color(c1), color(c2));
      this.grid.position.y = 0.012; this.grid.material.transparent = true; this.grid.material.opacity = lines ? 0.55 : 0.28;
      this.scene.add(this.grid);
    }
    const L = { day: [1.05, 2.3, '#ffffff', [8, 15, 7]], dusk: [0.7, 1.9, '#ffb07a', [-13, 5, 6]], night: [0.42, 0.9, '#9db8ff', [-6, 12, 4]], indoor: [1.0, 1.4, '#fff3e0', [3, 16, 8]] }[o.light] || [1.05, 2.3, '#ffffff', [8, 15, 7]];
    this.hemiBase = L[0]; this.sunBase = L[1];
    this.hemi.intensity = L[0]; this.hemi.color.copy(top).lerp(new THREE.Color('#ffffff'), 0.6); this.hemi.groundColor.copy(this.ground.material.color).lerp(new THREE.Color('#444444'), 0.3);
    this.sun.intensity = L[1]; this.sun.color.copy(color(L[2])); this.sun.position.set(...L[3]);
    this.sun.castShadow = !lines;
  }

  _geo(shape) {
    const lo = this.style.seg === 'lo';
    const key = `${shape}:${lo ? 'lo' : 'hi'}`;
    if (this.geoCache.has(key)) return this.geoCache.get(key);
    let g;
    if (shape === 'sphere') g = lo ? new THREE.IcosahedronGeometry(0.5, 1) : new THREE.SphereGeometry(0.5, 36, 24);
    else if (shape === 'cyl') g = new THREE.CylinderGeometry(0.5, 0.5, 1, lo ? 8 : 36);
    else if (shape === 'cone') g = new THREE.ConeGeometry(0.5, 1, lo ? 7 : 36);
    else if (shape === 'torus') { g = new THREE.TorusGeometry(0.38, 0.12, lo ? 6 : 16, lo ? 10 : 40); g.rotateX(Math.PI / 2); }
    // Square-based pyramid, flat-faced, base w x d.
    else if (shape === 'pyramid') { g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); g.rotateY(Math.PI / 4); g = g.toNonIndexed(); g.computeVertexNormals(); }
    // A triangular prism lying along x: a roof, a ramp, a wedge of cheese.
    else if (shape === 'wedge') {
      const tri = new THREE.Shape([new THREE.Vector2(-0.5, -0.5), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0, 0.5)]);
      g = new THREE.ExtrudeGeometry(tri, { depth: 1, bevelEnabled: false }); g.translate(0, 0, -0.5); g.rotateY(Math.PI / 2); g.computeVertexNormals();
    }
    // Half a sphere sitting on its flat side: a dome, a mound, a hill, a helmet.
    else if (shape === 'dome') { g = new THREE.SphereGeometry(0.5, lo ? 10 : 36, lo ? 5 : 14, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, 2, 1); g.translate(0, -0.5, 0); }
    // A rounded rod: limbs, fingers, pills, sausages.
    else if (shape === 'capsule') { g = new THREE.CapsuleGeometry(0.5, 1, lo ? 3 : 8, lo ? 8 : 24); g.scale(1, 0.5, 1); }
    else g = new THREE.BoxGeometry(1, 1, 1);
    this.geoCache.set(key, g); return g;
  }
  _edges(shape) {
    const key = `${shape}:${this.style.seg}`;
    if (!this.edgeCache.has(key)) this.edgeCache.set(key, new THREE.EdgesGeometry(this._geo(shape), 24));
    return this.edgeCache.get(key);
  }
  _tinted(hex, ghost) {
    const st = this.style; const c = color(ghost ? GHOST : hex);
    if (!ghost && st.tint) c.lerp(new THREE.Color('#ffffff'), st.tint);
    if (!ghost && st.sat) { const h = c.getHSL({}); c.setHSL(h.h, clamp(h.s + st.sat, 0, 1), clamp(h.l, 0.25, 0.8)); }
    return c;
  }
  // Lit reflections for metal and glass, made once per stage from a simple studio room.
  _envMap() {
    if (!this.envTex) { const pm = new THREE.PMREMGenerator(this.renderer); this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    return this.envTex;
  }
  _mat(hex, ghost, finish = null) {
    const st = this.style; if (ghost) finish = null; const key = `${hex}|${ghost ? 1 : 0}|${finish || ''}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const c = this._tinted(hex, ghost); let m;
    if (finish === 'glow') {
      // A glowing part is its own light: never shaded, always at least fairly bright.
      const g = color(hex); const h = g.getHSL({}); g.setHSL(h.h, h.s, Math.max(h.l, 0.55));
      m = new THREE.MeshBasicMaterial({ color: g, toneMapped: false });
    } else if (finish === 'metal' && st.shade !== 'lines' && st.shade !== 'toon') m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.85, envMap: this._envMap(), envMapIntensity: 1, flatShading: st.shade === 'flat' });
    else if (finish === 'glass' && st.shade !== 'lines') {
      m = st.shade === 'toon' ? new THREE.MeshToonMaterial({ color: c, gradientMap: this.toonMap }) : new THREE.MeshStandardMaterial({ color: c, roughness: 0.05, metalness: 0.1, envMap: this._envMap(), envMapIntensity: 1.4 });
      Object.assign(m, { transparent: true, opacity: 0.4, depthWrite: false });
    } else if (st.shade === 'lines') m = new THREE.MeshBasicMaterial({ color: color(st.fill), transparent: st.fillOpacity < 1 || ghost, opacity: ghost ? st.fillOpacity * 0.35 : st.fillOpacity, depthWrite: st.fillOpacity >= 1 && !ghost });
    else if (st.shade === 'toon') m = new THREE.MeshToonMaterial({ color: c, gradientMap: this.toonMap });
    else m = new THREE.MeshStandardMaterial({ color: c, roughness: st.rough ?? 0.8, metalness: 0, flatShading: st.shade === 'flat' });
    if (ghost && st.shade !== 'lines') { m.transparent = true; m.opacity = 0.42; m.depthWrite = false; }
    this.matCache.set(key, m); return m;
  }
  _lineMat(hex, ghost) {
    const st = this.style; const key = `L|${hex}|${ghost ? 1 : 0}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    let c;
    if (st.line) c = color(st.line);
    else { c = color(ghost ? '#7f8aa8' : hex); const h = c.getHSL({}); if (!ghost) c.setHSL(h.h, Math.max(h.s, 0.85), clamp(h.l, 0.56, 0.72)); }
    const m = new THREE.LineBasicMaterial({ color: c, transparent: ghost, opacity: ghost ? 0.45 : 1 });
    this.matCache.set(key, m); return m;
  }

  _voxelPart(shape, w, h, d, hex, ghost, finish) {
    const vs = 0.2;
    const fit = (len) => clamp(Math.round(len / vs), 1, 14);
    const nx = fit(w), ny = fit(h), nz = fit(d);
    const cells = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const u = (i + 0.5) / nx - 0.5, v = (j + 0.5) / ny - 0.5, q = (k + 0.5) / nz - 0.5;
      let inside = true;
      if (shape === 'sphere') inside = u * u + v * v + q * q <= 0.27;
      else if (shape === 'cyl') inside = u * u + q * q <= 0.27;
      else if (shape === 'cone') { const r = 0.5 * (0.5 - v) + 0.06; inside = u * u + q * q <= r * r; }
      else if (shape === 'torus') { const rr = Math.sqrt(u * u + q * q) - 0.38; inside = (rr / 0.14) ** 2 + (v / 0.5) ** 2 <= 1.15; }
      else if (shape === 'pyramid') { const r = 0.5 * (0.5 - v) + 0.05; inside = Math.abs(u) <= r && Math.abs(q) <= r; }
      else if (shape === 'wedge') inside = Math.abs(q) <= 0.5 * (0.5 - v) + 0.05;
      else if (shape === 'dome') { const y = (v + 0.5) / 2; inside = u * u + q * q + y * y <= 0.27; }
      else if (shape === 'capsule') inside = u * u + q * q <= 0.27;
      if (inside) cells.push([u, v, q]);
    }
    if (!cells.length) cells.push([0, 0, 0]);
    const mesh = new THREE.InstancedMesh(this._geo('box'), this._mat(hex, ghost, finish), cells.length);
    const m = new THREE.Matrix4(); const sc = new THREE.Vector3((w / nx) * 0.94, (h / ny) * 0.94, (d / nz) * 0.94); const qn = new THREE.Quaternion(); const p = new THREE.Vector3();
    cells.forEach(([u, v, q], i) => { p.set(u * w, v * h, q * d); m.compose(p, qn, sc); mesh.setMatrixAt(i, m); });
    mesh.instanceMatrix.needsUpdate = true;
    this.disposables.push(mesh);
    return mesh;
  }

  _part(p, ghost) {
    if (!Array.isArray(p) || p.length < 3) return null;
    const shape = SHAPES.includes(p[0]) ? p[0] : (p[0] === 'cylinder' ? 'cyl' : p[0] === 'hemisphere' ? 'dome' : 'box');
    const finish = finishOf(p);
    const c = Array.isArray(p[1]) ? p[1] : [0, 0, 0]; const s = Array.isArray(p[2]) ? p[2] : [1, 1, 1];
    const w = clamp(Math.abs(num(s[0], 1)), 0.02, 40), h = clamp(Math.abs(num(s[1], 1)), 0.02, 40), d = clamp(Math.abs(num(s[2], w)), 0.02, 40);
    const hex = typeof p[3] === 'string' ? p[3] : '#b8bcc6';
    const st = this.style; let mesh;
    if (st.voxel) mesh = this._voxelPart(shape, w, h, d, hex, ghost, finish);
    else {
      mesh = new THREE.Mesh(this._geo(shape), this._mat(hex, ghost, finish));
      mesh.scale.set(w, shape === 'torus' ? h / 0.24 : h, d);
      if (st.shade === 'lines') mesh.add(new THREE.LineSegments(this._edges(shape), this._lineMat(hex, ghost)));
      if (st.outline && !ghost && finish !== 'glow') {
        if (!this.outlineMat) this.outlineMat = new THREE.MeshBasicMaterial({ color: 0x1b1626, side: THREE.BackSide });
        const o = new THREE.Mesh(this._geo(shape), this.outlineMat);
        const t = 0.05; o.scale.set(1 + t / Math.max(w, 0.15), 1 + t / Math.max(h, 0.15), 1 + t / Math.max(d, 0.15));
        mesh.add(o);
      }
    }
    if (st.shade !== 'lines') { mesh.castShadow = !ghost && finish !== 'glow' && finish !== 'glass'; mesh.receiveShadow = finish !== 'glow'; }
    mesh.position.set(clamp(num(c[0]), -30, 30), clamp(num(c[1]), -5, 40), clamp(num(c[2]), -30, 30));
    if (Array.isArray(p[4])) mesh.rotation.set(num(p[4][0]) * D2R, num(p[4][1]) * D2R, num(p[4][2]) * D2R);
    if (finish === 'glow' && !ghost) mesh.userData.glow = { hex, size: Math.max(w, h, d) };
    return mesh;
  }

  _group(parts, ghost) {
    const g = new THREE.Group();
    for (const p of (Array.isArray(parts) ? parts.slice(0, 24) : [])) {
      const m = this._part(p, ghost); if (!m) continue; g.add(m);
      // A glowing part gets a soft halo of its own light around it.
      if (m.userData.glow) {
        const key = `H|${m.userData.glow.hex}`;
        if (!this.matCache.has(key)) this.matCache.set(key, glowBlend(new THREE.SpriteMaterial({ map: fxTexture('halo'), color: color(m.userData.glow.hex) }), 0.55));
        const sp = new THREE.Sprite(this.matCache.get(key)); sp.userData.halo = true; sp.raycast = () => {};
        sp.position.copy(m.position); sp.scale.setScalar(clamp(m.userData.glow.size * 2.4, 0.3, 10)); g.add(sp);
        if (!g.userData.glow) g.userData.glow = { c: color(m.userData.glow.hex), y: m.position.y };
      }
    }
    return g;
  }
  // The bounds of an object's own parts, leaving out the halos around glowing ones.
  _box(g, box = new THREE.Box3()) {
    box.makeEmpty(); g.updateWorldMatrix(true, false);
    for (const ch of g.children) if (!ch.userData.halo) box.expandByObject(ch);
    return box;
  }

  _place(g, x, z, ry, s, anim, pop, delay, parent = this.root, o = {}) {
    g.position.set(clamp(num(x), -16, 16), 0, clamp(num(z), -16, 16));
    g.rotation.y = num(ry) * D2R;
    const sc = clamp(num(s, 1), 0.05, 12);
    g.userData = { x: g.position.x, z: g.position.z, ry: g.rotation.y, s: sc };
    // An actor is a thing on stage and everything that moves it: how it comes in, the step of the story it
    // comes in at, and its idle loop. Its place each frame is worked out from the story clock in _animate.
    const a = { g, anim: anim && anim !== 'none' ? anim : null, ph: Math.random() * 6.28, born: pop ? this._now() + delay : -1e9,
      step: clamp(Math.round(num(o.step)), 0, 8), enter: ENTERS.includes(o.in) ? o.in : 'pop' };
    g.userData.actor = a; this.actors.push(a); this._step(a.step, pop);
    g.scale.setScalar(pop || a.step ? 0.0001 : sc);
    parent.add(g); this.count++;
    return g;
  }

  _addObj(o, pop, delay) {
    const at = Array.isArray(o.at) ? o.at : [0, 0];
    const g = this._group(o.parts, Boolean(o.ghost));
    if (o.y) { g.children.forEach((c) => { c.position.y += num(o.y); }); if (g.userData.glow) g.userData.glow.y += num(o.y); }
    const glow = g.userData.glow;
    this._place(g, at[0], at.length > 2 ? at[2] : at[1], o.ry, o.s, o.anim, pop, delay, this.root, o);
    if (glow) g.userData.actor.glow = glow;
    if (o.id != null) this.groups.set(String(o.id), g);
    this._focus(g);
  }

  // Frame the camera on the first few things drawn (the subject comes first), ignoring huge backdrops.
  _focus(g) {
    if (this.mode === 'diagram' || this.focusN >= 4) return;
    const keep = g.scale.x; g.scale.setScalar(g.userData.s); g.updateMatrixWorld(true);
    const box = this._box(g); g.scale.setScalar(keep);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    if ((size.x > 11 || size.z > 11) && this.focusN > 0) return;
    if (size.x > 11 || size.z > 11) { box.min.x = Math.max(box.min.x, -3); box.max.x = Math.min(box.max.x, 3); box.min.z = Math.max(box.min.z, -3); box.max.z = Math.min(box.max.z, 3); }
    this.focusBox.union(box); this.focusN++; this._reframe();
  }
  _reframe() {
    if (this.mode === 'diagram' || this.focusBox.isEmpty()) return;
    this.lookNow = undefined;
    this._frameBox(this.focusBox, this.mode === 'storyboard' ? (SHOT_ZOOM[this.shotCam] ?? 1.05) : 1.12);
  }
  _frameBox(box, zoom) {
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const t = Math.tan((this.camera.fov * D2R) / 2);
    const asp = this.mode === 'storyboard' ? Math.min(this.camera.aspect, 9 / 16) : this.camera.aspect;
    const r = clamp(Math.max((size.x / 2) / (t * asp), (size.y / 2) / t) * 1.25 * zoom + size.z / 2 + 1.5, 4.5, 30);
    this.camT = { r, phi: SHOT_PHI[this.shotCam] ?? 72, y: clamp(c.y, 0.5, 6), x: clamp(c.x, -9, 9), z: clamp(c.z, -9, 9) };
  }

  // ---------- motion ----------
  // The story runs on a clock of steps. Step 0 is what is there from the start; things and motions with a
  // later step wait their turn, so the picture unfolds in the order the paragraph tells it, then loops.
  _step(step, live) { if (step > this.maxStep) this.maxStep = step; if (live && step && !this.playing) this.tl0 = this._now(); }
  _clock(now) {
    if (!this.maxStep) return { tt: 0, rw: 0, D: 1.8 };
    let D, total;
    // With a set length the steps share it, leaving a beat at the end for the last one to land.
    if (this.lenSec) { total = this.lenSec; D = clamp((total - 1.1) / (this.maxStep + 1), 0.3, 6); }
    else { D = this.shotSec ? clamp(this.shotSec / (this.maxStep + 1), 1.3, 3) : 1.8; total = (this.maxStep + 1) * D + 2.2; }
    if (this.playing) return { tt: (now - this.tl0) / 1000, D, rw: 0 };
    const tt = ((now - this.tl0) / 1000) % total;
    // The last moments of a loop wind everything back, so the restart is a motion too and not a cut.
    return { tt, D, rw: easeInOut(clamp((tt - (total - 0.8)) / 0.7, 0, 1)) };
  }
  // A place named by an object id, or given as [x,z] or [x,y,z]. For an object, y is a point inside its body.
  _point(ref) {
    if (Array.isArray(ref)) return ref.length > 2 ? { x: num(ref[0]), y: num(ref[1]), z: num(ref[2]) } : { x: num(ref[0]), y: 0, z: num(ref[1]) };
    const g = this.groups.get(String(ref)); if (!g) return null;
    const u = g.userData, st = u.actor?.st;
    if (u.h == null) { const keep = g.scale.clone(); g.scale.setScalar(u.s); const b = this._box(g); g.scale.copy(keep); u.h = b.isEmpty() ? 1 : clamp(b.max.y, 0.2, 8); }
    return { x: st ? st.x : u.x, y: (st ? st.y : 0) + u.h * 0.6, z: st ? st.z : u.z, body: true, g };
  }
  _addAct(o, pop) {
    if (!ACTS.includes(o.do)) return;
    const c = { o, key: actKey(o), do: o.do, id: o.id != null ? String(o.id) : null, step: clamp(Math.round(num(o.step, 1)), 0, 8), dur: clamp(num(o.dur, 1.3), 0.3, 6) };
    if (FX.includes(c.do)) { c.fx = makeFx(this, o, c.key); if (!c.fx) return; c.parts = [c.fx.group]; this.disposables.push(c.fx); }
    else if (c.do === 'flow') {
      const def = this.defs.get(String(o.of)), n = clamp(Math.round(num(o.n, 5)), 1, 12);
      c.parts = Array.from({ length: n }, () => { const g = this._group(def ? def.parts : [['sphere', [0, 0, 0], [0.26, 0.26, 0.26], typeof o.color === 'string' ? o.color : '#6ec5ff']], false); g.visible = false; this.root.add(g); return g; });
      c.s = clamp(num(def?.s, 1) * num(o.s, 1), 0.05, 6);
      // A stream has to be seen from across the stage, so its pieces are never smaller than a fist.
      const size = this._box(c.parts[0]).getSize(new THREE.Vector3()), big = Math.max(size.x, size.y, size.z) || 0.26;
      c.s = clamp(c.s, 0.42 / big, 0.9 / big); c.arc = clamp(num(o.arc), 0, 6); c.dur = clamp(num(o.dur, 2.2), 0.6, 8);
    } else if (c.do === 'flash') {
      const mat = new THREE.MeshBasicMaterial({ color: color(o.color, '#ffd24a'), transparent: true, depthWrite: false, fog: false });
      const geo = new THREE.TorusGeometry(0.5, 0.035, 8, 48); geo.rotateX(Math.PI / 2);
      c.ring = new THREE.Mesh(geo, mat); c.ring.visible = false; this.root.add(c.ring); this.disposables.push(geo, mat);
    }
    this.acts.push(c); this.acts.sort((a, b) => a.step - b.step); this._step(c.step, pop);
  }
  // A number that counts up (or down) in front of the viewer, like "1,900 prompts per bottle".
  _addCount(o, pop) {
    const at = Array.isArray(o.at) ? o.at : [0, 3, 0], from = num(o.from), to = num(o.to, 1);
    const dec = Math.min(2, Math.max(...[from, to].map((v) => (String(v).split('.')[1] || '').length)));
    const fmt = (v) => { const n = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); const t = String(o.text || '{n}').slice(0, 36); return t.includes('{n}') ? t.replace('{n}', n) : `${n} ${t}`; };
    const fs = 54, pad = 26, cv = document.createElement('canvas'); let ctx = cv.getContext('2d');
    ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
    cv.width = Math.ceil(Math.max(ctx.measureText(fmt(from)).width, ctx.measureText(fmt(to)).width)) + pad * 2; cv.height = fs + pad * 1.4; ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false });
    const sp = new THREE.Sprite(mat); sp.renderOrder = 11; sp.visible = false;
    sp.position.set(clamp(num(at[0]), -14, 14), clamp(num(at[1], 3), 0.4, 14), clamp(num(at[2]), -14, 14));
    const draw = (text) => {
      ctx.clearRect(0, 0, cv.width, cv.height); ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(14,17,26,0.86)'; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, cv.height / 2); ctx.fill();
      ctx.fillStyle = '#ffd24a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(text, cv.width / 2, cv.height / 2 + 2); tex.needsUpdate = true;
    };
    this.root.add(sp); this.disposables.push(tex, mat);
    const c = { o, key: actKey(o), sp, draw, fmt, from, to, w: cv.width / cv.height, step: clamp(Math.round(num(o.step, 1)), 0, 8), dur: clamp(num(o.dur, 1.6), 0.3, 6), shown: null };
    c.tx = { sp, anchor: sp.position.clone(), frac: clamp(num(o.size, 0.95), 0.4, 2) * 0.052, w: c.w, k: 0 }; this.texts.push(c.tx);
    this.counts.push(c); this._step(c.step, pop);
  }
  _animate(t, now) {
    const { tt, D, rw } = this._clock(now);
    this.lightReq = []; this.flashK = 0;
    for (const a of this.actors) {
      const u = a.g.userData, st = a.st = { x: u.x, y: 0, z: u.z, s: u.s, sy: 1, ry: u.ry, rz: 0, show: true, moving: false };
      let k = clamp((now - a.born) / 480, 0, 1);
      if (a.step) k = Math.min(k, clamp((tt - a.step * D) / 0.6, 0, 1)) * (1 - rw);
      if (k <= 0) st.show = false;
      else if (k < 1) {
        if (a.enter === 'drop') { st.y += (1 - bounce(k)) * 7; st.s *= Math.min(1, k * 6); }
        else if (a.enter === 'grow') st.sy = Math.max(0.001, easeOut(k));
        else if (a.enter === 'left' || a.enter === 'right') { st.x += (a.enter === 'left' ? -1 : 1) * (1 - easeOut(k)) * 12; st.s *= Math.min(1, k * 6); }
        else st.s *= Math.max(0.0001, easeOutBack(k));
      }
    }
    let look = null;
    for (const c of this.acts) {
      if (c.fx) continue; // effects follow their objects, so they are placed after everything has moved
      const live = tt - c.step * D, raw = clamp(live / c.dur, 0, 1), k = raw * (1 - rw), e = easeInOut(k);
      if (c.do === 'look') { if (live >= 0 && rw < 0.5 && this.maxStep) look = c; continue; }
      if (c.do === 'flow') {
        const A = this._point(c.o.from), B = this._point(c.o.to), n = c.parts.length;
        c.parts.forEach((g, i) => {
          const local = live - (i * c.dur) / n; g.visible = Boolean(A && B) && local >= 0 && rw < 1;
          if (!g.visible) return;
          const kk = (local / c.dur) % 1;
          g.position.set(A.x + (B.x - A.x) * kk, A.y + (B.y - A.y) * kk + Math.sin(Math.PI * kk) * c.arc, A.z + (B.z - A.z) * kk);
          g.scale.setScalar(Math.max(0.0001, c.s * Math.sin(Math.PI * kk) ** 0.5 * (1 - rw)));
        });
        continue;
      }
      const groups = [this.groups.get(c.id), ...(c.do === 'move' ? [] : this.copies.get(c.id) || [])];
      for (const g of groups) {
        const st = g?.userData.actor?.st; if (!st) continue;
        if (c.do === 'move') {
          const to = this._point(c.o.to); if (!to || to.g === g) continue;
          let tx = to.x, tz = to.z;
          // Going to another thing means arriving next to it, not inside it.
          if (to.body) { const dx = tx - st.x, dz = tz - st.z, len = Math.hypot(dx, dz) || 1, gap = Math.min(1.2, len * 0.4); tx -= (dx / len) * gap; tz -= (dz / len) * gap; }
          st.x += (tx - st.x) * e; st.z += (tz - st.z) * e; st.y += num(c.o.y) * e + Math.sin(Math.PI * k) * clamp(num(c.o.arc), 0, 8);
          st.moving = raw > 0 && raw < 1;
        } else if (c.do === 'grow') st.s *= 1 + (clamp(num(c.o.k, 2), 0.1, 6) - 1) * e;
        else if (c.do === 'vanish') st.s *= Math.max(0.0001, 1 - e);
        else if (c.do === 'spin') st.ry += e * Math.PI * 2 * clamp(num(c.o.turns, 1), 0.25, 4);
        else if (c.do === 'shake') { if (raw > 0 && raw < 1) { st.x += Math.sin(t * 46) * 0.05 * st.s; st.rz += Math.sin(t * 39) * 0.05; } }
        else if (c.do === 'rise') { if (live >= 0) { const kk = (live / c.dur) % 1; st.y += clamp(num(c.o.h, 2.5), 0.3, 10) * kk * (1 - rw); st.s *= Math.max(0.0001, Math.sin(Math.PI * kk) ** 0.6); } }
        else if (c.do === 'flash' && g === groups[0]) {
          const on = raw > 0 && raw < 1; c.ring.visible = on && st.show;
          if (on) { const kk = (raw * 2) % 1; c.ring.position.set(st.x, 0.06, st.z); c.ring.scale.setScalar((0.8 + 2.6 * kk) * Math.max(1, st.s)); c.ring.material.opacity = 1 - kk; st.s *= 1 + 0.1 * Math.sin(Math.PI * raw * 4) ** 2; }
        }
      }
    }
    // The camera follows the story: a look act frames one thing for its step, then the view goes back.
    if (look !== (this.lookNow ?? null) && this.mode !== 'diagram') {
      const g = look && this.groups.get(look.id);
      if (g) { const keep = g.scale.clone(); g.scale.setScalar(g.userData.s); const b = this._box(g); g.scale.copy(keep); if (!b.isEmpty()) this._frameBox(b, look.o.zoom === 'close' ? 1.1 : 1.6); this.lookNow = look; }
      else { this._reframe(); this.lookNow = null; }
    }
    for (const a of this.actors) {
      const g = a.g, st = a.st, s = g.userData.s;
      if (a.anim === 'bob') st.y += 0.1 * s * (1 + Math.sin(t * 2.2 + a.ph));
      else if (a.anim === 'sway') st.rz += 0.07 * Math.sin(t * 1.4 + a.ph);
      else if (a.anim === 'spin') st.ry += t * 1.3;
      else if (a.anim === 'hop') st.y += Math.abs(Math.sin(t * 3.2 + a.ph)) * 0.4 * s;
      else if (a.anim === 'float') st.y += 0.9 + 0.3 * Math.sin(t * 1.1 + a.ph);
      else if (a.anim === 'float0') st.y += 0.12 + 0.1 * Math.sin(t * 1.6 + a.ph);
      else if (a.anim === 'pulse') st.s *= 1 + 0.07 * Math.sin(t * 3.4 + a.ph);
      else if (a.anim === 'walk') {
        // A walker with somewhere to go walks there; one without wanders on the spot.
        const going = this.acts.some((c) => c.do === 'move' && this.groups.get(c.id) === g);
        if (!going) { const k = Math.sin(t * 0.8 + a.ph); st.x += k * 1.4; st.ry += Math.cos(t * 0.8 + a.ph) >= 0 ? 0 : Math.PI; }
        if (!going || st.moving) st.y += Math.abs(Math.sin(t * 5 + a.ph)) * 0.08 * s;
      }
      if (st.moving && a.anim !== 'walk' && a.anim !== 'float') st.y += Math.abs(Math.sin(t * 7 + a.ph)) * 0.05 * s;
      g.visible = st.show; g.position.set(st.x, st.y, st.z); g.rotation.y = st.ry; g.rotation.z = st.rz; g.scale.set(st.s, st.s * st.sy, st.s);
      if (a.glow && st.show && st.s > 0.05) this.fxLight(st.x, st.y + a.glow.y * st.s * st.sy, st.z, a.glow.c, 5 * clamp(st.s, 0.3, 3));
    }
    // An effect from step 0 belongs to the place (a campfire, rain), so it runs on without winding back at each loop.
    const run = (now - this.tl0) / 1000;
    for (const c of this.acts) if (c.fx) c.fx.update(c.step ? { live: tt - c.step * D, rw, t, D } : { live: run, rw: 0, t, D });
    for (const c of this.counts) {
      const live = tt - c.step * D, k = clamp(live / c.dur, 0, 1), inK = clamp(live / 0.35, 0, 1) * (1 - rw);
      c.sp.visible = inK > 0; if (!c.sp.visible) continue;
      const text = c.fmt(c.from + (c.to - c.from) * easeOut(k)); if (text !== c.shown) { c.shown = text; c.draw(text); }
      c.tx.k = easeOutBack(inK);
    }
  }
  // ---------- effects ----------
  // Where an effect is: on an object (its bounds as they are this frame) or at a point [x,z] or [x,y,z].
  fxTarget(ref) {
    if (ref == null) return null;
    if (Array.isArray(ref)) { const p = this._point(ref); const c = new THREE.Vector3(p.x, p.y, p.z); const box = new THREE.Box3(c.clone().subScalar(0.3), c.clone().addScalar(0.3)); return { c, box, size: new THREE.Vector3(0.6, 0.6, 0.6), point: true }; }
    const g = this.groups.get(String(ref)); if (!g || !g.parent || !g.visible || g.scale.x < 0.05) return null;
    const box = this._box(g); if (box.isEmpty()) return null;
    return { c: box.getCenter(new THREE.Vector3()), box, size: box.getSize(new THREE.Vector3()), g };
  }
  fxPoint(ref, where = 'center') {
    const T = this.fxTarget(ref); if (!T) return null;
    if (T.point) return { x: T.c.x, y: T.c.y, z: T.c.z };
    return { x: T.c.x, y: where === 'top' ? T.box.max.y : where === 'upper' ? T.box.min.y + T.size.y * 0.7 : T.c.y, z: T.c.z };
  }
  fxLight(x, y, z, c, i) { if (i > 0.05) this.lightReq.push({ x, y, z, c, i }); }
  fxFlash(k) { this.flashK = Math.max(this.flashK, k); }
  _shareLights() {
    const req = this.lightReq.sort((a, b) => b.i - a.i);
    this.fxLights.forEach((l, n) => { const r = req[n]; if (!r) { l.intensity = 0; return; } l.position.set(r.x, r.y, r.z); l.color.copy(r.c); l.intensity = r.i; });
    // A lightning strike lights the whole scene for a moment.
    this.hemi.intensity = this.hemiBase + this.flashK * 1.4; this.sun.intensity = this.sunBase + this.flashK * 0.8;
  }

  _addMany(o, pop, delay) {
    const def = this.defs.get(String(o.of)); if (!def || !Array.isArray(o.at)) return;
    o.at.slice(0, 60).forEach((a, i) => {
      if (!Array.isArray(a)) return;
      const g = this._group(def.parts, Boolean(def.ghost));
      this._place(g, a[0], a[1], a[3] ?? (i * 73) % 360, num(def.s, 1) * num(a[2], 1), def.anim, pop, delay + i * 35, this.root, { step: o.step ?? def.step, in: o.in ?? def.in });
      const of = String(o.of); if (!this.copies.has(of)) this.copies.set(of, []);
      this.copies.get(of).push(g);
    });
  }

  _sprite(text, opts = {}) {
    const fs = 44, pad = 22; const cv = document.createElement('canvas'); let ctx = cv.getContext('2d');
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    const tw = Math.ceil(ctx.measureText(text).width);
    cv.width = tw + pad * 2; cv.height = fs + pad * 1.4; ctx = cv.getContext('2d');
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = opts.bg || 'rgba(14,17,26,0.82)';
    const r = cv.height / 2; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, r); ctx.fill();
    if (opts.dashed) { ctx.setLineDash([10, 8]); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke(); }
    ctx.fillStyle = opts.fg || '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(text, pad, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false });
    const sp = new THREE.Sprite(mat); const hgt = opts.size || 0.62;
    sp.scale.set(hgt * (cv.width / cv.height), hgt, 1); sp.renderOrder = 10;
    this.disposables.push(tex, mat);
    return sp;
  }

  _addLabel(o) {
    const at = Array.isArray(o.at) ? o.at : [0, 3, 0]; if (!o.text) return;
    const sp = this._sprite(String(o.text).slice(0, 40));
    sp.position.set(clamp(num(at[0]), -14, 14), clamp(num(at[1], 3), 0.4, 14), clamp(num(at[2]), -14, 14));
    this.root.add(sp);
    this.texts.push({ sp, anchor: sp.position.clone(), frac: 0.036, w: sp.scale.x / sp.scale.y, k: 1 });
  }

  // Text in the scene (labels and counting numbers) is laid out on the screen, not in the world: it keeps one
  // readable size however far the camera zooms, stays inside the visible frame, and never sits on other text.
  _layoutTexts() {
    if (!this.texts.length) return;
    const cam = this.camera; cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const tan = Math.tan((cam.fov * D2R) / 2), crop = this.mode === 'storyboard' ? Math.min(1, 9 / 16 / cam.aspect) : 1, placed = [];
    for (const tx of this.texts) {
      const sp = tx.sp; if (!sp.parent || !sp.visible || tx.k <= 0) continue;
      const v = tx.anchor.clone().project(cam); if (v.z >= 1 || v.z <= -1) continue;
      let h = tx.frac * 2 * tx.k, w = (h * tx.w) / cam.aspect; const maxW = crop * 2 * 0.9;
      if (w > maxW) { h *= maxW / w; w = maxW; }
      const x = clamp(v.x, -crop + w / 2 + 0.03, crop - w / 2 - 0.03); let y = clamp(v.y, -0.2 + h / 2, 0.84 - h / 2);
      for (let i = 0; i < 8; i++) {
        const hit = placed.find((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < (p.h + h) / 2 + 0.015); if (!hit) break;
        y = hit.y - (hit.h + h) / 2 - 0.03; if (y < -0.5) { y = placed.reduce((m, p) => Math.max(m, p.y + p.h / 2), -1) + h / 2 + 0.03; break; }
      }
      placed.push({ x, y, w, h });
      const p = new THREE.Vector3(x, y, v.z).unproject(cam), depth = -p.clone().applyMatrix4(cam.matrixWorldInverse).z, wh = h * depth * tan;
      sp.position.copy(p); sp.scale.set(wh * tx.w, wh, 1);
    }
  }

  // A thing the story is about must never be buried. The model sometimes stacks several things on one spot, so
  // the subject ends up inside another (quartz inside a granite chamber). Twice a second, each object from the
  // first drawing is checked from the camera at five points; if every one is blocked by things standing on the
  // same spot, those turn see-through for as long as the scene is shown. Something merely behind another thing
  // (a pipe behind a desk) is ordinary depth and is left alone, as is anything that starts hidden on purpose
  // because it rises or moves out later or is only the pattern for a flow, and objects added by improve passes (setting_, background_, ...).
  _reveal() {
    if (this.mode === 'diagram' || !this.groups.size) return;
    const ray = this._ray || (this._ray = new THREE.Raycaster()); ray.camera = this.camera;
    const cam = this.camera.position, top = (o) => { while (o && o.parent !== this.root) o = o.parent; return o; };
    const shown = (g) => g.visible && g.scale.x > 0.05;
    const leaves = new Set(this.acts.flatMap((c) => (c.do === 'move' || c.do === 'rise' ? [c.id] : c.do === 'flow' ? [String(c.o.of)] : [])));
    const spot = (a, b) => Math.hypot(a.userData.x - b.userData.x, a.userData.z - b.userData.z) < 0.6;
    for (const [id, g] of this.groups) {
      if (/^(subject|setting|background|polish|motion|refine|remotion|staging)_/.test(id) || leaves.has(id) || !g.parent || !shown(g)) continue;
      const box = this._box(g); if (box.isEmpty()) continue;
      const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()).multiplyScalar(0.3);
      const pts = [c, c.clone().add(new THREE.Vector3(sz.x, 0, 0)), c.clone().add(new THREE.Vector3(-sz.x, 0, 0)), c.clone().add(new THREE.Vector3(0, sz.y, 0)), c.clone().add(new THREE.Vector3(0, -sz.y, sz.z))];
      const blockers = new Set(); let seen = false;
      for (const p of pts) {
        const dir = p.clone().sub(cam), far = dir.length(); ray.set(cam, dir.normalize()); ray.far = far - 0.02;
        const hit = ray.intersectObject(this.root, true).find((h) => {
          if (!h.object.isMesh) return false; const tg = top(h.object);
          return tg && tg !== g && !tg.userData.fx && !this.faded.has(tg) && shown(tg) && !g.getObjectById(h.object.id);
        });
        if (!hit || !spot(top(hit.object), g)) { seen = true; break; }
        blockers.add(top(hit.object));
      }
      // Hidden on two checks in a row, so a camera still gliding in from the last scene does not fade anything.
      if (seen) { this.hiddenOnce.delete(id); continue; }
      if (!this.hiddenOnce.has(id)) { this.hiddenOnce.add(id); continue; }
      for (const b of blockers) this._fade(b);
    }
  }
  _fade(g) {
    if (this.faded.has(g)) return; this.faded.add(g);
    g.traverse((m) => {
      if (!m.isMesh && !m.isLineSegments) return;
      const mat = m.material.clone(); mat.transparent = true; mat.opacity = (m.material.opacity ?? 1) * 0.3; mat.depthWrite = false;
      m.material = mat; m.castShadow = false; this.disposables.push(mat);
    });
  }

  _ghostBox(w, h, d) {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const mat = new THREE.LineDashedMaterial({ color: this.bgLum > 0.55 ? 0x4a5163 : 0xdfe5f5, dashSize: 0.18, gapSize: 0.14 });
    const ln = new THREE.LineSegments(geo, mat); ln.computeLineDistances(); ln.position.y = h / 2;
    this.disposables.push(geo, mat);
    return ln;
  }

  _addGap(o, pop, delay) {
    const at = Array.isArray(o.at) ? o.at : [0, 0];
    const g = new THREE.Group(); g.add(this._ghostBox(1.3, 1.9, 1.3));
    const q = this._sprite('?', { size: 0.9, bg: 'rgba(255,95,95,0.92)' }); q.position.y = 1.0; g.add(q);
    if (o.text) { const t = this._sprite(String(o.text).slice(0, 48), { size: 0.5, dashed: true }); t.position.y = 2.5; g.add(t); }
    this._place(g, at[0], at[1], 0, 1, 'float0', pop, delay);
    this._focus(g);
  }

  _addNode(o, pop, delay) {
    if (o.id == null || this.nodes.has(String(o.id))) return;
    const kind = NODE_KINDS[o.kind] || NODE_KINDS.service; const ghost = Boolean(o.ghost);
    let col = clamp(Math.round(num(o.col)), 0, 7), row = clamp(Math.round(num(o.row)), 0, 5);
    const taken = () => [...this.nodes.values()].some((n) => n.col === col && n.row === row);
    for (let i = 0; i < 12 && taken(); i++) { row++; if (row > 5) { row = 0; col++; } }
    const g = ghost ? new THREE.Group() : this._group(kind.parts, false);
    if (ghost) { g.add(this._ghostBox(2.2, 1.3, 1.5)); const q = this._sprite('?', { size: 0.8, bg: 'rgba(255,95,95,0.92)' }); q.position.y = 0.7; g.add(q); }
    const label = this._sprite(String(o.label || o.id).slice(0, 34), { size: 0.56, dashed: ghost }); label.position.y = (ghost ? 1.3 : kind.h) + 0.75; g.add(label);
    const x = col * 4.6, z = row * 4.4;
    this._place(g, x, z, 0, 1, null, pop, delay, this.diagram);
    g.position.set(x, 0, z); g.userData.x = x; g.userData.z = z;
    this.nodes.set(String(o.id), { col, row, x, z, h: ghost ? 1.3 : kind.h });
    const ns = [...this.nodes.values()];
    const cx = (Math.min(...ns.map((n) => n.x)) + Math.max(...ns.map((n) => n.x))) / 2;
    const cz = (Math.min(...ns.map((n) => n.z)) + Math.max(...ns.map((n) => n.z))) / 2;
    this.diagramTarget.set(-cx, 0, -cz + 1);
    const spanX = Math.max(...ns.map((n) => n.x)) - Math.min(...ns.map((n) => n.x));
    const spanZ = Math.max(...ns.map((n) => n.z)) - Math.min(...ns.map((n) => n.z));
    const tn = Math.tan((this.camera.fov * D2R) / 2);
    this.camT = { ...CAMS.diagram, r: clamp(Math.max((spanX + 6) / 2 / (tn * this.camera.aspect), (spanZ + 7) / 2 / tn) * 1.12, 13, 44) };
    const waiting = this.pendingEdges; this.pendingEdges = [];
    waiting.forEach((e) => this._addEdge(e, true));
  }

  _addEdge(o, retry = false) {
    const a = this.nodes.get(String(o.a)), b = this.nodes.get(String(o.b));
    if (!a || !b) { this.pendingEdges.push(o); return; }
    if (a === b) return;
    const A = new THREE.Vector3(a.x, 0.7, a.z), B = new THREE.Vector3(b.x, 0.7, b.z);
    const dir = B.clone().sub(A); const len = dir.length(); dir.normalize();
    const inset = Math.min(1.5, len * 0.3);
    const P0 = A.clone().addScaledVector(dir, inset), P2 = B.clone().addScaledVector(dir, -inset);
    const mid = P0.clone().add(P2).multiplyScalar(0.5); mid.y += 0.9 + len * 0.1;
    const curve = new THREE.QuadraticBezierCurve3(P0, mid, P2);
    const col = this.style.shade === 'lines' ? color(this.style.grid?.[0] || '#ffffff') : color(this.bgLum > 0.55 ? '#2b3242' : '#f1f4ff');
    const mat = new THREE.MeshBasicMaterial({ color: col });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.055, 6), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 10), mat);
    const tan = curve.getTangent(1); head.position.copy(P2); head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({ color: color('#ffd24a') }));
    this.diagram.add(tube, head, pulse);
    this.pulses.push({ pulse, curve, ph: Math.random() });
    this.disposables.push(tube.geometry, head.geometry, pulse.geometry, mat, pulse.material);
    if (o.label) { const sp = this._sprite(String(o.label).slice(0, 26), { size: 0.42, bg: 'rgba(40,46,62,0.9)' }); sp.position.copy(curve.getPoint(0.5)); sp.position.y += 0.45; this.diagram.add(sp); }
  }

  _bindPointer() {
    const el = this.renderer.domElement; let drag = null;
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.userTheta -= (e.clientX - drag.x) * 0.006; this.userPhi = clamp(this.userPhi - (e.clientY - drag.y) * 0.25, -50, 20);
      drag = { x: e.clientX, y: e.clientY }; this.lastTouch = performance.now();
    });
    el.addEventListener('pointerup', () => { drag = null; });
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = clamp(this.zoom * (1 + e.deltaY * 0.001), 0.4, 2.2); this.lastTouch = performance.now(); }, { passive: false });
    el.addEventListener('dblclick', () => { this.userTheta = 0; this.userPhi = 0; this.zoom = 1; });
  }

  _resize() {
    const [w, h] = this.fixed || [this.container.clientWidth || 1, this.container.clientHeight || 1];
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
  }

  _frame() {
    const now = this._now(), t = now / 1000;
    // Easing by elapsed time, not by frame, so the camera moves the same at 30 frames a second as at 120.
    const dt = clamp(this.lastNow == null ? 1 / 60 : (now - this.lastNow) / 1000, 0, 0.25); this.lastNow = now;
    const ease = (k) => 1 - Math.pow(1 - k, dt * 60);
    for (const k of ['r', 'phi', 'y', 'x', 'z']) this.cam[k] += ((this.camT[k] ?? 0) - this.cam[k]) * ease(0.07);
    const sway = Math.sin(t * 0.24) * 0.36;
    const theta = sway + this.userTheta; const phi = clamp(this.cam.phi + this.userPhi, 8, 88) * D2R; const r = this.cam.r * this.zoom;
    this.camera.position.set(this.cam.x + r * Math.sin(phi) * Math.sin(theta), this.cam.y + r * Math.cos(phi), this.cam.z + r * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(this.cam.x, this.cam.y, this.cam.z);
    this.diagram.position.lerp(this.diagramTarget, ease(0.08));
    this._animate(t, now);
    this._shareLights();
    if (now - this.lastReveal > 500) { this.lastReveal = now; this._reveal(); }
    this._layoutTexts();
    for (const p of this.pulses) p.pulse.position.copy(p.curve.getPoint((t * 0.45 + p.ph) % 1));
    this.renderer.render(this.scene, this.camera);
  }
}
