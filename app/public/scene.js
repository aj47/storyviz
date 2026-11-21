// 3D stage: draws scene lines (env, obj, many, label, gap, node, edge, shot) the moment
// they arrive, in whichever visual style is active. Restyling rebuilds from the stored lines.
import * as THREE from 'three';

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
  constructor(container, hooks = {}) {
    this.container = container; this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    this._bindPointer();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // ---------- public ----------
  setMode(mode) { this.mode = mode; this.shotCam = null; this.camT = { ...(mode === 'diagram' ? CAMS.diagram : CAMS.wide) }; }
  setStyle(name) {
    if (!STYLES[name]) return;
    this.styleName = name; this.style = STYLES[name];
    this.matCache.clear();
    const lines = this.lines; this._clearObjects(); this.lines = [];
    this._applyEnv(this.env || {});
    for (const l of lines) this.addLine(l, false);
  }
  clear() { this._clearObjects(); this.lines = []; this.env = null; this._applyEnv({}); this.setMode(this.mode); }
  load(lines, pop = false) { this.clear(); lines.forEach((l, i) => this.addLine(l, pop, i * 45)); }
  get objectCount() { return this.count; }

  // Apply a line from an improvement pass: an obj with a known id replaces that object where it
  // stands, a new env replaces the old one, and anything else is added.
  upsert(o, pop = true) {
    if (!o || typeof o !== 'object') return;
    const id = o.t === 'obj' && o.id != null ? String(o.id) : null;
    const at = id && this.groups.has(id) ? this.lines.findIndex((l) => l.t === 'obj' && String(l.id) === id)
      : o.t === 'env' || o.t === 'shot' ? this.lines.findIndex((l) => l.t === o.t) : -1;
    if (id && this.groups.has(id)) this._remove([this.groups.get(id)]);
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
        case 'shot': this.shotCam = o.cam || 'medium'; this._reframe(); this.hooks.onShot?.(o); break;
        default: break;
      }
    } catch (e) { console.warn('bad scene line', o, e); }
  }

  // Take an object, and every copy a many line made of it, off the stage.
  drop(id) {
    id = String(id);
    this._remove([this.groups.get(id), ...(this.copies.get(id) || [])].filter(Boolean));
    this.groups.delete(id); this.copies.delete(id); this.defs.delete(id);
    this.lines = this.lines.filter((l) => !((l.t === 'obj' && String(l.id) === id) || (l.t === 'many' && String(l.of) === id)));
  }
  _remove(groups) {
    for (const g of groups) g.parent?.remove(g);
    this.anims = this.anims.filter((a) => !groups.includes(a.g)); this.pops = this.pops.filter((p) => !groups.includes(p.g));
  }

  // ---------- internals ----------
  _resetState() {
    this.defs = new Map(); this.groups = new Map(); this.copies = new Map(); this.nodes = new Map(); this.pendingEdges = [];
    this.anims = []; this.pops = []; this.pulses = []; this.disposables = []; this.count = 0;
    this.focusBox = new THREE.Box3(); this.focusN = 0; this.shotCam = null;
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
    this.container.style.background = `linear-gradient(#${top.getHexString()} 0%, #${hor.getHexString()} 62%, #${hor.getHexString()} 100%)`;
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
  _mat(hex, ghost) {
    const st = this.style; const key = `${hex}|${ghost ? 1 : 0}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const c = this._tinted(hex, ghost); let m;
    if (st.shade === 'lines') m = new THREE.MeshBasicMaterial({ color: color(st.fill), transparent: st.fillOpacity < 1 || ghost, opacity: ghost ? st.fillOpacity * 0.35 : st.fillOpacity, depthWrite: st.fillOpacity >= 1 && !ghost });
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

  _voxelPart(shape, w, h, d, hex, ghost) {
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
      if (inside) cells.push([u, v, q]);
    }
    if (!cells.length) cells.push([0, 0, 0]);
    const mesh = new THREE.InstancedMesh(this._geo('box'), this._mat(hex, ghost), cells.length);
    const m = new THREE.Matrix4(); const sc = new THREE.Vector3((w / nx) * 0.94, (h / ny) * 0.94, (d / nz) * 0.94); const qn = new THREE.Quaternion(); const p = new THREE.Vector3();
    cells.forEach(([u, v, q], i) => { p.set(u * w, v * h, q * d); m.compose(p, qn, sc); mesh.setMatrixAt(i, m); });
    mesh.instanceMatrix.needsUpdate = true;
    this.disposables.push(mesh);
    return mesh;
  }

  _part(p, ghost) {
    if (!Array.isArray(p) || p.length < 3) return null;
    const shape = ['box', 'sphere', 'cyl', 'cone', 'torus'].includes(p[0]) ? p[0] : (p[0] === 'cylinder' ? 'cyl' : 'box');
    const c = Array.isArray(p[1]) ? p[1] : [0, 0, 0]; const s = Array.isArray(p[2]) ? p[2] : [1, 1, 1];
    const w = clamp(Math.abs(num(s[0], 1)), 0.02, 40), h = clamp(Math.abs(num(s[1], 1)), 0.02, 40), d = clamp(Math.abs(num(s[2], w)), 0.02, 40);
    const hex = typeof p[3] === 'string' ? p[3] : '#b8bcc6';
    const st = this.style; let mesh;
    if (st.voxel) mesh = this._voxelPart(shape, w, h, d, hex, ghost);
    else {
      mesh = new THREE.Mesh(this._geo(shape), this._mat(hex, ghost));
      mesh.scale.set(w, shape === 'torus' ? h / 0.24 : h, d);
      if (st.shade === 'lines') mesh.add(new THREE.LineSegments(this._edges(shape), this._lineMat(hex, ghost)));
      if (st.outline && !ghost) {
        if (!this.outlineMat) this.outlineMat = new THREE.MeshBasicMaterial({ color: 0x1b1626, side: THREE.BackSide });
        const o = new THREE.Mesh(this._geo(shape), this.outlineMat);
        const t = 0.05; o.scale.set(1 + t / Math.max(w, 0.15), 1 + t / Math.max(h, 0.15), 1 + t / Math.max(d, 0.15));
        mesh.add(o);
      }
    }
    if (st.shade !== 'lines') { mesh.castShadow = !ghost; mesh.receiveShadow = true; }
    mesh.position.set(clamp(num(c[0]), -30, 30), clamp(num(c[1]), -5, 40), clamp(num(c[2]), -30, 30));
    if (Array.isArray(p[4])) mesh.rotation.set(num(p[4][0]) * D2R, num(p[4][1]) * D2R, num(p[4][2]) * D2R);
    return mesh;
  }

  _group(parts, ghost) {
    const g = new THREE.Group();
    for (const p of (Array.isArray(parts) ? parts.slice(0, 24) : [])) { const m = this._part(p, ghost); if (m) g.add(m); }
    return g;
  }

  _place(g, x, z, ry, s, anim, pop, delay, parent = this.root) {
    g.position.set(clamp(num(x), -16, 16), 0, clamp(num(z), -16, 16));
    g.rotation.y = num(ry) * D2R;
    const sc = clamp(num(s, 1), 0.05, 12);
    g.userData = { x: g.position.x, z: g.position.z, ry: g.rotation.y, s: sc };
    if (pop) { g.scale.setScalar(0.0001); this.pops.push({ g, t0: performance.now() + delay, s: sc }); } else g.scale.setScalar(sc);
    if (anim && anim !== 'none') this.anims.push({ g, type: anim, ph: Math.random() * 6.28 });
    parent.add(g); this.count++;
    return g;
  }

  _addObj(o, pop, delay) {
    const at = Array.isArray(o.at) ? o.at : [0, 0];
    const g = this._group(o.parts, Boolean(o.ghost));
    if (o.y) g.children.forEach((c) => { c.position.y += num(o.y); });
    this._place(g, at[0], at.length > 2 ? at[2] : at[1], o.ry, o.s, o.anim, pop, delay);
    if (o.id != null) this.groups.set(String(o.id), g);
    this._focus(g);
  }

  // Frame the camera on the first few things drawn (the subject comes first), ignoring huge backdrops.
  _focus(g) {
    if (this.mode === 'diagram' || this.focusN >= 4) return;
    const keep = g.scale.x; g.scale.setScalar(g.userData.s); g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g); g.scale.setScalar(keep);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    if ((size.x > 11 || size.z > 11) && this.focusN > 0) return;
    if (size.x > 11 || size.z > 11) { box.min.x = Math.max(box.min.x, -3); box.max.x = Math.min(box.max.x, 3); box.min.z = Math.max(box.min.z, -3); box.max.z = Math.min(box.max.z, 3); }
    this.focusBox.union(box); this.focusN++; this._reframe();
  }
  _reframe() {
    if (this.mode === 'diagram' || this.focusBox.isEmpty()) return;
    const size = this.focusBox.getSize(new THREE.Vector3()), c = this.focusBox.getCenter(new THREE.Vector3());
    const t = Math.tan((this.camera.fov * D2R) / 2);
    const asp = this.mode === 'storyboard' ? Math.min(this.camera.aspect, 9 / 16) : this.camera.aspect;
    const zoom = this.mode === 'storyboard' ? (SHOT_ZOOM[this.shotCam] ?? 1.05) : 1.12;
    const r = clamp(Math.max((size.x / 2) / (t * asp), (size.y / 2) / t) * 1.25 * zoom + size.z / 2 + 1.5, 4.5, 30);
    this.camT = { r, phi: SHOT_PHI[this.shotCam] ?? 72, y: clamp(c.y, 0.5, 6), x: clamp(c.x, -9, 9), z: clamp(c.z, -9, 9) };
  }
  _addMany(o, pop, delay) {
    const def = this.defs.get(String(o.of)); if (!def || !Array.isArray(o.at)) return;
    o.at.slice(0, 60).forEach((a, i) => {
      if (!Array.isArray(a)) return;
      const g = this._group(def.parts, Boolean(def.ghost));
      this._place(g, a[0], a[1], a[3] ?? (i * 73) % 360, num(def.s, 1) * num(a[2], 1), def.anim, pop, delay + i * 35);
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
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
  }

  _frame() {
    const t = this.clock.getElapsedTime(), now = performance.now();
    for (const k of ['r', 'phi', 'y', 'x', 'z']) this.cam[k] += ((this.camT[k] ?? 0) - this.cam[k]) * 0.07;
    const sway = Math.sin(t * 0.24) * 0.36;
    const theta = sway + this.userTheta; const phi = clamp(this.cam.phi + this.userPhi, 8, 88) * D2R; const r = this.cam.r * this.zoom;
    this.camera.position.set(this.cam.x + r * Math.sin(phi) * Math.sin(theta), this.cam.y + r * Math.cos(phi), this.cam.z + r * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(this.cam.x, this.cam.y, this.cam.z);
    this.diagram.position.lerp(this.diagramTarget, 0.08);
    this.pops = this.pops.filter((p) => {
      const k = (now - p.t0) / 480; if (k < 0) return true;
      p.g.scale.setScalar(Math.max(0.0001, p.s * easeOutBack(k))); return k < 1;
    });
    for (const a of this.anims) {
      const g = a.g, u = g.userData, s = u.s;
      if (a.type === 'bob') g.position.y = 0.1 * s * (1 + Math.sin(t * 2.2 + a.ph));
      else if (a.type === 'sway') g.rotation.z = 0.07 * Math.sin(t * 1.4 + a.ph);
      else if (a.type === 'spin') g.rotation.y = u.ry + t * 1.3;
      else if (a.type === 'hop') g.position.y = Math.abs(Math.sin(t * 3.2 + a.ph)) * 0.4 * s;
      else if (a.type === 'float') g.position.y = 0.9 + 0.3 * Math.sin(t * 1.1 + a.ph);
      else if (a.type === 'float0') g.position.y = 0.12 + 0.1 * Math.sin(t * 1.6 + a.ph);
      else if (a.type === 'pulse') { if (!this.pops.some((p) => p.g === g)) g.scale.setScalar(s * (1 + 0.07 * Math.sin(t * 3.4 + a.ph))); }
      else if (a.type === 'walk') { const k = Math.sin(t * 0.8 + a.ph); g.position.x = u.x + k * 1.4; g.position.y = Math.abs(Math.sin(t * 5 + a.ph)) * 0.08 * s; g.rotation.y = u.ry + (Math.cos(t * 0.8 + a.ph) >= 0 ? 0 : Math.PI); }
    }
    for (const p of this.pulses) p.pulse.position.copy(p.curve.getPoint((t * 0.45 + p.ph) % 1));
    this.renderer.render(this.scene, this.camera);
  }
}
