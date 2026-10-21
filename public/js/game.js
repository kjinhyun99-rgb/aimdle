// aimdle.io game client. THREE is the global from the three.js script tag in index.html.
import { clamp, lerp, mulberry32, hashStr, gauss, fmtInt, pad2 } from './shared/util.js';
import { DAY_MS, utcDay, dayKey, dailyInfo } from './shared/daily.js';
import { DPS, SCORE, SCENARIOS, sceneTag, fmtScore, SCORE_TEXT } from './shared/scenes.js';
import { validateRun } from './shared/validate.js';

// ---------- utils ----------
const $ = (s) => document.querySelector(s);
const store = {
  // reads fall back to keys from earlier names (aimweb, flickday) so settings and scores carry over
  get(k, d) { try { const v = localStorage.getItem('aimdle:' + k) ?? localStorage.getItem('aimweb:' + k) ?? localStorage.getItem('flickday:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('aimdle:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

// ---------- settings ----------
const GAMES = {
  valorant: { label: 'Valorant', yaw: 0.07, fov: 103, sensLabel: 'Valorant sensitivity' },
  cs2: { label: 'Counter-Strike 2', yaw: 0.022, fov: 106.26, sensLabel: 'CS2 sensitivity' },
  apex: { label: 'Apex Legends', yaw: 0.022, fov: 106.26, sensLabel: 'Apex mouse sensitivity' },
  ow2: { label: 'Overwatch 2', yaw: 0.0066, fov: 103, sensLabel: 'Overwatch 2 sensitivity' },
  custom: { label: 'Custom', yaw: null, fov: null, sensLabel: '' },
};
const HUD_ITEMS = [['timer', 'Timer'], ['session', 'Session stats (score, kills, accuracy, KPS, TTK, tracking meter)'], ['fps', 'FPS counter']];
const DEFAULTS = {
  game: 'valorant', sens: 0.4, cm360: 35, dpi: 800, fov: 103, fovFromGame: true,
  xhStyle: 'cross', xhColor: '#ffff00', xhSize: 5, xhThick: 2, xhGap: 3, xhOutline: true,
  targetColor: '#ff2a2a', volume: 0.5, hitmarker: true, rawMode: 'auto', renderScale: 1, smoothing: 0, hitSound: 'pop', trackSound: 'soft', muted: false, inputSrc: 'mouse', boxRoom: true,
  hud: Object.fromEntries(HUD_ITEMS.map(([k]) => [k, true])),
};
const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
S.hud = Object.assign({}, DEFAULTS.hud, S.hud || {});
const saveSettings = () => store.set('settings', S);
// v2 defaults: raw input off. Applies once to settings saved by earlier builds.
// v3: raw input is chosen per system by default ('auto'): on for Windows/Linux/ChromeOS, off for macOS.
if (store.get('settingsV', 1) < 3) { S.rawMode = 'auto'; S.smoothing = 0; delete S.rawPref; store.set('settingsV', 3); saveSettings(); }
// v4: box room on by default
if (store.get('settingsV', 1) < 4) { S.boxRoom = true; store.set('settingsV', 4); saveSettings(); }
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent);
const wantRaw = () => S.rawMode === 'on' || (S.rawMode === 'auto' && !IS_MAC);
function degPerCount() {
  if (S.game === 'custom') return 360 / ((Math.max(1, S.cm360) / 2.54) * Math.max(1, S.dpi));
  return Math.max(0.0001, S.sens) * GAMES[S.game].yaw;
}
const cmPer360 = () => (360 / degPerCount() / Math.max(1, S.dpi)) * 2.54;

// ---------- world (three.js) ----------
// Void style: a grey 3D-editor viewport. A fading floor grid with red (X) and green (Y) axis
// lines, the target wall as a gridded panel with thick dark edges, and props as grey solids with
// the same hard edges. B switches between "wall only" and a full gridded box room.
// No textures are loaded or generated, which keeps start-up and frame cost low.
const VOID = {
  bg: 0x393939, wall: 0x434343, wallGrid: 0x4e4e4e, edge: 0x151515,
  gridMinor: 0x444444, gridMajor: 0x515151, axisX: 0xe0475a, axisY: 0x86c23a, prop: 0x4c4c4c,
};
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const scene = new THREE.Scene();
scene.background = new THREE.Color(VOID.bg);
scene.fog = new THREE.Fog(VOID.bg, 40, 160); // fades the far grid so thin lines don't shimmer
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 500);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 0.45); sun.position.set(-4, 10, 6); scene.add(sun);
let world = new THREE.Group(); scene.add(world);

const SPHERE_GEO = new THREE.SphereGeometry(1, 32, 20);
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1);
const SHADOW_GEO = new THREE.CircleGeometry(1, 28);
const SHARED_GEO = new Set([SPHERE_GEO, BOX_GEO, SHADOW_GEO]);
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
const EDGE_MAT = new THREE.MeshBasicMaterial({ color: VOID.edge });
const WALL_MAT = new THREE.MeshBasicMaterial({ color: VOID.wall });
const WALL_GRID_MAT = new THREE.LineBasicMaterial({ color: VOID.wallGrid });
const PROP_MAT = new THREE.MeshLambertMaterial({ color: VOID.prop });
const noRay = () => {};

// Floor grid + axes: built once and kept for every scenario (the floor is always y = 0).
(function buildGround() {
  const g = new THREE.Group();
  const minor = new THREE.GridHelper(300, 300, VOID.gridMinor, VOID.gridMinor);
  const major = new THREE.GridHelper(300, 30, VOID.gridMajor, VOID.gridMajor); major.position.y = 0.004;
  const axis = (color, alongX) => { const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 300 : 0.05, 0.02, alongX ? 0.05 : 300), new THREE.MeshBasicMaterial({ color })); m.position.y = 0.012; return m; };
  g.add(minor, major, axis(VOID.axisX, true), axis(VOID.axisY, false));
  g.traverse((o) => { o.raycast = noRay; });
  scene.add(g);
})();

// WebGL draws lines 1 px wide, so thick edges are thin boxes between two points (axis-aligned).
function edgeBar(a, b, th, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(b[0] - a[0]) + th, Math.abs(b[1] - a[1]) + th, Math.abs(b[2] - a[2]) + th), EDGE_MAT);
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); m.raycast = noRay; parent.add(m); return m;
}
function boxEdges(x0, x1, y0, y1, z0, z1, th, parent) {
  [x0, x1].forEach((x) => [y0, y1].forEach((y) => edgeBar([x, y, z0], [x, y, z1], th, parent)));
  [y0, y1].forEach((y) => [z0, z1].forEach((z) => edgeBar([x0, y, z], [x1, y, z], th, parent)));
  [x0, x1].forEach((x) => [z0, z1].forEach((z) => edgeBar([x, y0, z], [x, y1, z], th, parent)));
}
// A solid panel with a 2-unit grid drawn just in front of it.
function gridPanel(w, h) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), WALL_MAT));
  const pts = [];
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += 2) pts.push(x, -h / 2, 0, x, h / 2, 0);
  for (let y = -h / 2; y <= h / 2 + 1e-6; y += 2) pts.push(-w / 2, y, 0, w / 2, y, 0);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, WALL_GRID_MAT); lines.position.z = 0.01; g.add(lines);
  g.traverse((o) => { o.raycast = noRay; });
  return g;
}

const EDGE = 0.07;
const ROOM = { wall: null, box: null };
function buildRoom(room) {
  const { w, h, front, back } = room, d = back - front, x0 = -w / 2, x1 = w / 2;
  // wall only: the front wall floating in the void, outlined
  const wallG = new THREE.Group();
  const fw = gridPanel(w, h); fw.position.set(0, h / 2, front); wallG.add(fw);
  edgeBar([x0, 0, front], [x1, 0, front], EDGE, wallG); edgeBar([x0, h, front], [x1, h, front], EDGE, wallG);
  edgeBar([x0, 0, front], [x0, h, front], EDGE, wallG); edgeBar([x1, 0, front], [x1, h, front], EDGE, wallG);
  // box room: front, back, sides and ceiling as gridded panels (the floor stays the ground grid), all 12 edges thick
  const boxG = new THREE.Group();
  const f = gridPanel(w, h); f.position.set(0, h / 2, front); boxG.add(f);
  const bk = gridPanel(w, h); bk.position.set(0, h / 2, back); bk.rotation.y = Math.PI; boxG.add(bk);
  const l = gridPanel(d, h); l.position.set(x0, h / 2, (front + back) / 2); l.rotation.y = Math.PI / 2; boxG.add(l);
  const r = gridPanel(d, h); r.position.set(x1, h / 2, (front + back) / 2); r.rotation.y = -Math.PI / 2; boxG.add(r);
  const c = gridPanel(w, d); c.position.set(0, h, (front + back) / 2); c.rotation.x = Math.PI / 2; boxG.add(c);
  boxEdges(x0, x1, 0, h, front, back, EDGE, boxG);
  world.add(wallG, boxG);
  ROOM.wall = wallG; ROOM.box = boxG;
  applyRoomStyle();
  (room.props || []).forEach(addProp);
  if (room.platform) addDisc(0, 0.9, -0.6, 4, 0.9);
}
function applyRoomStyle() {
  if (!ROOM.wall) return;
  ROOM.wall.visible = !S.boxRoom; ROOM.box.visible = !!S.boxRoom;
}
// Props (ledges, stairs, platforms): grey solids with thin hard edges.
function addProp({ x0, x1, y0 = 0, y1, z0, z1 }) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), PROP_MAT);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); m.raycast = noRay; world.add(m);
  boxEdges(x0, x1, y0, y1, z0, z1, 0.045, world);
  return m;
}
function addDisc(x, top, z, radius, thick) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, thick, 64), PROP_MAT);
  m.position.set(x, top - thick / 2, z); m.raycast = noRay; world.add(m);
  [top, top - thick].forEach((y) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.03, 6, 96), EDGE_MAT);
    ring.rotation.x = Math.PI / 2; ring.position.set(x, y, z); ring.raycast = noRay; world.add(ring);
  });
  return m;
}
// Health bar: a camera-facing pair of quads above bots that have finite health.
const BAR_BG_GEO = new THREE.PlaneGeometry(1.08, 0.16);
const BAR_FILL_GEO = new THREE.PlaneGeometry(1, 0.1); BAR_FILL_GEO.translate(0.5, 0, 0);
const BAR_BG_MAT = new THREE.MeshBasicMaterial({ color: 0x10161d, transparent: true, opacity: 0.8, depthWrite: false });
[BAR_BG_GEO, BAR_FILL_GEO].forEach((g) => SHARED_GEO.add(g));
const SHARED_MAT = new Set([SHADOW_MAT, PROP_MAT, BAR_BG_MAT, EDGE_MAT, WALL_MAT, WALL_GRID_MAT]);
function disposeWorld() {
  world.traverse((o) => {
    if (o.geometry && !SHARED_GEO.has(o.geometry)) o.geometry.dispose();
    if (o.material && !SHARED_MAT.has(o.material)) o.material.dispose();
  });
  scene.remove(world); world = new THREE.Group(); scene.add(world);
  ROOM.wall = ROOM.box = null;
}

// ---------- engine ----------
const G = {
  state: 'intro', mode: 'free', scnIdx: 0, scn: null, impl: null, targets: [],
  stats: null, locked: false, firing: false, rawInput: null,
  countdown: 0, resumeTo: 'free', daily: dailyInfo(), yaw: 0, pitch: 0, pendX: 0, pendY: 0,
  meter: 0, tickCd: 0, run: null, occluders: [],
};
const newStats = () => ({ kills: 0, clickShots: 0, clickHits: 0, trackFire: 0, trackOn: 0, damage: 0, sphereKills: 0, botKills: 0, killTimes: [], activeMs: 0 });

function makeCtx(seed, room, eye) {
  const rng = mulberry32(seed), mrng = mulberry32(seed ^ 0x9E3779B9);
  const color = new THREE.Color(S.targetColor);
  const mkMat = (c) => new THREE.MeshLambertMaterial({ color: c, emissive: c.clone().multiplyScalar(0.28) });
  const clickTarget = (geo, scale, x, y, z, opts = {}) => {
    const mat = mkMat(opts.color != null ? new THREE.Color(opts.color) : color);
    const mesh = new THREE.Mesh(geo, mat); mesh.scale.setScalar(scale); mesh.position.set(x, y, z);
    const t = { kind: 'click', mesh, mat, flash: 0, fixedColor: opts.color != null }; mesh.userData.t = t;
    world.add(mesh); G.targets.push(t); return t;
  };
  // health bar above a target: camera-facing quads, turned each frame in the main loop
  const makeBar = (parent, y) => {
    const bar = new THREE.Group(); bar.position.y = y;
    const bg = new THREE.Mesh(BAR_BG_GEO, BAR_BG_MAT); bg.raycast = noRay;
    const barMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    const barFill = new THREE.Mesh(BAR_FILL_GEO, barMat); barFill.position.set(-0.5, 0, 0.002); barFill.raycast = noRay;
    bar.add(bg, barFill); parent.add(bar);
    return { bar, barFill, barMat };
  };
  const ctx = {
    rng, mrng, room, eye,
    addSphere: (x, y, z, r, opts) => clickTarget(SPHERE_GEO, r, x, y, z, opts),
    // a sphere you track (hold fire) instead of click
    addTrackSphere(x, y, z, r, hp = Infinity) {
      const mat = mkMat(color);
      const ball = new THREE.Mesh(SPHERE_GEO, mat); ball.scale.setScalar(r);
      const grp = new THREE.Group(); grp.add(ball); grp.position.set(x, y, z);
      const t = { kind: 'track', mesh: grp, mat, hp, maxHp: hp, flash: 0 };
      if (Number.isFinite(hp)) Object.assign(t, makeBar(grp, r + 0.32));
      grp.traverse((o) => { o.userData.t = t; });
      world.add(grp); G.targets.push(t); return t;
    },
    // a bot body that is not a target (for headshot-only scenes)
    addBody({ r, h }) {
      const mat = mkMat(color), grp = new THREE.Group();
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(0.01, h - 2 * r), 28), mat); cyl.position.y = h / 2;
      const top = new THREE.Mesh(SPHERE_GEO, mat); top.scale.setScalar(r); top.position.y = h - r;
      const bot = new THREE.Mesh(SPHERE_GEO, mat); bot.scale.setScalar(r); bot.position.y = r;
      grp.add(cyl, top, bot); world.add(grp); return grp;
    },
    addCube: (x, y, z, size) => clickTarget(BOX_GEO, size, x, y, z),
    addProp,
    // a prop that blocks shots (cover); a target behind it can't be hit through it
    addCover(box) { const m = addProp(box); m.raycast = THREE.Mesh.prototype.raycast; G.occluders.push(m); return m; },
    addDisc,
    // y is the bot's foot height; bots may float. ground is where its shadow falls.
    addBot({ r, h, x, y, z, hp, head, ground = 0, barScale = 1, click = false }) {
      const mat = mkMat(color);
      const grp = new THREE.Group();
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(0.01, h - 2 * r), 28), mat); cyl.position.y = h / 2;
      const top = new THREE.Mesh(SPHERE_GEO, mat); top.scale.setScalar(r); top.position.y = h - r;
      const bot = new THREE.Mesh(SPHERE_GEO, mat); bot.scale.setScalar(r); bot.position.y = r;
      grp.add(cyl, top, bot);
      let headMat = null;
      if (head) {
        headMat = mkMat(new THREE.Color(0xf2f2f2));
        const hm = new THREE.Mesh(SPHERE_GEO, headMat); hm.scale.setScalar(head.r); hm.position.y = h + head.gap + head.r;
        grp.add(hm);
      }
      const shadow = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT); shadow.rotation.x = -Math.PI / 2; shadow.scale.setScalar(r * 1.6);
      world.add(grp, shadow);
      const t = { kind: click ? 'click' : 'track', mesh: grp, mat, headMat, shadow, hp, maxHp: hp, flash: 0, ground: ground + 0.02 };
      if (Number.isFinite(hp)) { Object.assign(t, makeBar(grp, (head ? h + head.gap + head.r * 2 : h) + 0.38 * barScale)); t.bar.scale.setScalar(barScale); }
      grp.traverse((o) => { o.userData.t = t; });
      ctx.placeBot(t, x, y, z); G.targets.push(t); return t;
    },
    placeBot(t, x, y, z) { t.mesh.position.set(x, y, z); t.shadow.position.set(x, t.ground, z); },
    remove(t) {
      const i = G.targets.indexOf(t); if (i >= 0) G.targets.splice(i, 1);
      world.remove(t.mesh); if (t.shadow) world.remove(t.shadow);
      t.mat.dispose(); if (t.headMat) t.headMat.dispose(); if (t.barMat) t.barMat.dispose();
      if (t.kind === 'track' && t.mesh.isGroup && !SHARED_GEO.has(t.mesh.children[0].geometry)) t.mesh.children[0].geometry.dispose();
    },
  };
  return ctx;
}

function loadScenario(idx, mode) {
  disposeWorld();
  G.targets = []; G.occluders = [];
  G.scnIdx = idx; G.scn = SCENARIOS[idx]; G.mode = mode;
  // Ranked runs use the day's seed so everyone gets the same spawn sequence; free play is random.
  const seed = mode === 'challenge' ? hashStr(G.daily.key + ':' + G.scn.id) : (Math.random() * 2 ** 32) >>> 0;
  const room = G.scn.room;
  G.eye = room.eye ?? room.h / 2;
  camera.position.set(0, G.eye, 0);
  buildRoom(room);
  G.impl = G.scn.build(makeCtx(seed, room, G.eye));
  G.stats = newStats(); G.meter = 0;
  G.yaw = 0; G.pitch = 0; G.pendX = G.pendY = 0; applyLook();
  G.timeLeft = 60;
  applyFov();
  updateHudStatic();
}

function applyFov() {
  const h = Math.max(S.fov, (G.scn && G.scn.fovMin) || 0);
  const ref = Math.tan((h * Math.PI) / 360) / (16 / 9);
  camera.fov = (2 * Math.atan(ref) * 180) / Math.PI; // vertical FOV, Hor+ from a 16:9 reference
  camera.updateProjectionMatrix();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * S.renderScale);
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// dt > 0: a render frame. With smoothing on, only part of the pending movement is applied
// each frame (exponential glide with time constant S.smoothing), hiding coarse input steps.
// dt = 0: a shot. With smoothing on, the shot uses exactly what is on screen.
function applyLook(dt = 0) {
  let fx = G.pendX, fy = G.pendY;
  const tau = S.smoothing;
  if (tau > 0) {
    if (dt > 0) { const a = 1 - Math.exp(-dt / tau); fx *= a; fy *= a; } else { fx = fy = 0; }
  }
  if (fx || fy) {
    const k = (degPerCount() * Math.PI) / 180;
    G.yaw -= fx * k; G.pitch -= fy * k;
    G.pitch = clamp(G.pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    G.pendX -= fx; G.pendY -= fy;
    if (Math.abs(G.pendX) < 1e-4) G.pendX = 0;
    if (Math.abs(G.pendY) < 1e-4) G.pendY = 0;
  }
  camera.rotation.set(G.pitch, G.yaw, 0);
  camera.updateMatrixWorld();
}

const raycaster = new THREE.Raycaster();
const CENTER = new THREE.Vector2(0, 0);
function rayHit(kind) {
  const list = G.targets.filter((t) => t.kind === kind).map((t) => t.mesh);
  if (!list.length) return undefined;
  raycaster.setFromCamera(CENTER, camera);
  // cover (G.occluders) is tested too: if the nearest thing hit is cover, the shot is blocked
  const hits = raycaster.intersectObjects(G.occluders.length ? list.concat(G.occluders) : list, true);
  return hits.length ? hits[0].object.userData.t || null : null;
}
const isPlaying = () => G.locked && (G.state === 'free' || G.state === 'challenge');

function shoot() {
  applyLook();
  const t = rayHit('click');
  if (t === undefined) return; // no click targets right now (tracking phase)
  const s = G.stats; s.clickShots++;
  if (t) {
    s.clickHits++; s.kills++; s.sphereKills++; s.killTimes.push(Math.round(s.activeMs));
    sfx.kill(); hitmark();
    G.impl.onClickKill && G.impl.onClickKill(t);
  }
}
function trackStep(dt) {
  if (!G.targets.some((t) => t.kind === 'track')) { G.meter = Math.max(0, G.meter - dt * 2); return; }
  let on = false;
  if (G.firing) {
    const s = G.stats; s.trackFire += dt;
    const t = rayHit('track');
    if (t) {
      on = true; s.trackOn += dt; s.damage += DPS * dt; t.flash = 1;
      G.tickCd -= dt; if (G.tickCd <= 0) { sfx.tick(); G.tickCd = 0.075; }
      if (Number.isFinite(t.hp)) {
        t.hp -= DPS * dt;
        if (t.hp <= 0) { s.kills++; s.botKills++; s.killTimes.push(Math.round(s.activeMs)); sfx.kill(); hitmark(); G.impl.onBotKill && G.impl.onBotKill(t); }
      }
    }
  }
  G.meter += ((on ? 1 : 0) - G.meter) * Math.min(1, dt * (G.firing ? 5 : 2));
}

// input
// Movement is applied unrounded and unfiltered: every count the browser reports turns into
// rotation at the next frame. Only mousemove is read. Listening to pointerrawupdate as well
// double-counted movement in some browsers while a mouse button was held.
const MI = { n: 0, ints: 0, minStep: Infinity, t0: performance.now(), hz: 0, step: null, fractional: false, src: 'mousemove' };
function onMove(e) {
  if (!G.locked) return;
  const dx = e.movementX, dy = e.movementY;
  if (Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return; // only drop absurd browser spikes
  G.pendX += dx; G.pendY += dy;
  // diagnostics for the settings panel
  MI.n++; MI.src = e.type;
  const ax = Math.abs(dx); if (ax > 0) { MI.minStep = Math.min(MI.minStep, ax); if (dx !== Math.round(dx)) MI.fractional = true; }
  const now = performance.now();
  if (now - MI.t0 >= 1000) { MI.hz = Math.round((MI.n * 1000) / (now - MI.t0)); MI.step = MI.minStep === Infinity ? null : MI.minStep; MI.n = 0; MI.minStep = Infinity; MI.t0 = now; }
}
// Input source: 'mouse' reads mousemove, 'pointer' reads pointermove. Only one is ever counted.
document.addEventListener('mousemove', (e) => { if (S.inputSrc !== 'pointer') onMove(e); });
document.addEventListener('pointermove', (e) => { if (S.inputSrc === 'pointer' && e.pointerType === 'mouse') onMove(e); });
document.addEventListener('mousedown', (e) => {
  if (!G.locked || e.button !== 0) return;
  G.firing = true;
  if (isPlaying()) shoot();
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) G.firing = false; });
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'm' || e.key === 'M') { setMuted(!S.muted); return; }
  if (e.key === 'b' || e.key === 'B') { S.boxRoom = !S.boxRoom; saveSettings(); applyRoomStyle(); syncSettingsUI(); return; }
  if (!G.locked) return;
  if ((e.key === 'r' || e.key === 'R') && G.state === 'free') { G.stats = newStats(); }
});

async function lockPointer() {
  ac(); // unlock audio on this user gesture
  try {
    if (!wantRaw()) throw new Error('raw input off');
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.then) await p;
    G.rawInput = true;
  } catch (err) {
    try { const p2 = canvas.requestPointerLock(); if (p2 && p2.then) await p2; G.rawInput = false; }
    catch (err2) { G.state = 'paused'; showMenuNote('Your browser blocked mouse lock. Wait a second, then click again.'); }
  }
}
document.addEventListener('pointerlockchange', () => {
  G.locked = document.pointerLockElement === canvas;
  G.firing = false;
  if (G.locked) {
    hideSheets();
    if (G.state === 'pending') { G.state = 'countdown'; }
  } else if (G.state === 'free' || G.state === 'challenge' || G.state === 'countdown') {
    G.resumeTo = G.mode;
    G.state = 'paused';
    openMenu();
  }
});
document.addEventListener('pointerlockerror', () => { if (G.state === 'pending') { G.state = 'paused'; openMenu(); showMenuNote('Mouse lock failed. Click the button again in a moment.'); } });

function startCountdown(mode) { G.state = 'pending'; G.countdown = mode === 'challenge' ? 3 : 0.0001; G.resumeTo = mode; lockPointer(); }

// ---------- main loop ----------
let last = performance.now(), fpsAcc = 0, fpsN = 0, fpsShown = 0, hudT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const real = Math.min(0.25, (now - last) / 1000); last = now;
  const dt = Math.min(real, 0.05);
  fpsAcc += real; fpsN++; if (fpsAcc >= 0.25) { fpsShown = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  applyLook(real);

  if (G.state === 'countdown' && G.locked) {
    const before = Math.ceil(G.countdown);
    G.countdown -= real;
    const after = Math.ceil(G.countdown);
    if (G.resumeTo === 'challenge' && after !== before && after > 0) sfx.count();
    if (G.countdown <= 0) { G.state = G.resumeTo; if (G.resumeTo === 'challenge') sfx.go(); }
  }
  if (isPlaying()) {
    G.impl.update && G.impl.update(dt);
    trackStep(real);
    G.stats.activeMs += real * 1000;
    if (G.state === 'challenge' && G.stats.activeMs >= 60000) endChallenge();
  }
  for (const t of G.targets) {
    if (t.flash > 0) { t.flash = Math.max(0, t.flash - dt * 8); }
    const base = 0.28 + t.flash * 0.5; t.mat.emissive.copy(t.mat.color).multiplyScalar(base);
    if (t.headMat) t.headMat.emissive.copy(t.headMat.color).multiplyScalar(base);
    if (t.bar) {
      const f = clamp(t.hp / t.maxHp, 0, 1);
      t.bar.quaternion.copy(camera.quaternion);
      t.barFill.scale.x = Math.max(0.001, f);
      t.barMat.color.setRGB(lerp(0.94, 0.29, f), lerp(0.27, 0.87, f), lerp(0.27, 0.5, f));
    }
  }
  renderer.render(scene, camera);
  hudT += real; if (hudT > 0.05) { hudT = 0; updateHud(); }
  updateMeter();
}

// ---------- HUD ----------
function setHudVisibility() {
  document.querySelectorAll('#hud [data-hud]').forEach((el) => { el.hidden = !S.hud[el.dataset.hud]; });
  const showMeter = S.hud.session && G.scn && G.scn.kind !== 'click';
  $('#hud-meter').hidden = !showMeter;
}
function updateHudStatic() {
  $('#hud-scn-name').textContent = G.scn.name;
  const daily = G.scnIdx === G.daily.idx;
  $('#hud-scn-tag').textContent = `SCENE #${G.scnIdx + 1} · ${G.mode === 'challenge' ? 'RANKED' : daily ? "TODAY'S CHALLENGE · FREE PLAY" : 'FREE PLAY'}`;
  $('#hud-mode').textContent = G.mode === 'challenge' ? 'CHALLENGE' : 'SESSION';
  setHudVisibility();
}
function statLine() {
  const s = G.stats, sec = s.activeMs / 1000;
  const parts = [];
  if (s.clickShots) parts.push(s.clickHits / s.clickShots);
  if (s.trackFire > 0.05) parts.push(s.trackOn / s.trackFire);
  const acc = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return { score: SCORE[G.scn.score](s), acc, kps: sec > 0 ? s.kills / sec : 0, ttk: s.kills ? sec / s.kills : null, sec };
}
function updateHud() {
  if (!G.stats) return;
  const L = statLine();
  $('#hud-score').textContent = fmtScore(G.scn, L.score);
  $('#hud-kills').textContent = G.stats.kills;
  $('#hud-acc').textContent = L.acc == null ? '–' : (L.acc * 100).toFixed(1) + '%';
  $('#hud-kps').textContent = L.kps.toFixed(2);
  $('#hud-ttk').textContent = L.ttk == null ? '–' : L.ttk.toFixed(2) + 's';
  const total = Math.floor(L.sec);
  $('#hud-elapsed').textContent = `+${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  const tEl = $('#hud-timer');
  if (G.mode === 'challenge') {
    const secs = Math.ceil(Math.max(0, 60 - G.stats.activeMs / 1000));
    tEl.textContent = `${Math.floor(secs / 60)}:${pad2(secs % 60)}`;
    tEl.classList.remove('free');
  } else { tEl.textContent = 'FREE PLAY'; tEl.classList.add('free'); }
  $('#hud-fps').firstChild.nodeValue = Math.round(fpsShown) + ' ';
  const cm = $('#center-msg');
  if (G.state === 'countdown' && G.resumeTo === 'challenge') { cm.hidden = false; cm.innerHTML = `${Math.max(1, Math.ceil(G.countdown))}<small>RANKED RUN</small>`; }
  else cm.hidden = true;
}
function updateMeter() { $('#hud-needle').style.left = (G.meter * 100).toFixed(1) + '%'; }
let hitTimer = 0;
function hitmark() { if (!S.hitmarker) return; const el = $('#hitmark'); el.classList.add('on'); clearTimeout(hitTimer); hitTimer = setTimeout(() => el.classList.remove('on'), 60); }

function crosshairSVG() {
  const c = 32, L = S.xhSize, T = S.xhThick, Gp = S.xhGap, col = S.xhColor;
  const rects = [];
  if (S.xhStyle === 'cross' || S.xhStyle === 'crossdot') {
    rects.push([c + Gp, c - T / 2, L, T], [c - Gp - L, c - T / 2, L, T], [c - T / 2, c - Gp - L, T, L], [c - T / 2, c + Gp, T, L]);
  }
  if (S.xhStyle === 'dot' || S.xhStyle === 'crossdot') { const d = Math.max(2, T); rects.push([c - d / 2, c - d / 2, d, d]); }
  let out = '', fill = '';
  if (S.xhStyle === 'circle') {
    const r = Gp + L / 2 + 1;
    if (S.xhOutline) out = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#000" stroke-width="${T + 2}"/>`;
    fill = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${T}"/>`;
  }
  if (S.xhOutline) out += rects.map(([x, y, w, h]) => `<rect x="${x - 1}" y="${y - 1}" width="${w + 2}" height="${h + 2}" fill="#000"/>`).join('');
  fill += rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${col}"/>`).join('');
  return `<svg viewBox="0 0 64 64" width="64" height="64" shape-rendering="crispEdges">${out}${fill}</svg>`;
}
function renderCrosshair() { const svg = crosshairSVG(); $('#crosshair').innerHTML = svg; $('#xh-preview').innerHTML = svg; }

// ---------- audio ----------
let actx = null;
function ac() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } } if (actx && actx.state === 'suspended') actx.resume(); return actx; }
function blip(freq, dur, type, gain) {
  const a = actx; if (!a || S.volume <= 0 || S.muted) return;
  const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime;
  o.type = type; o.frequency.setValueAtTime(freq, t0); o.frequency.exponentialRampToValueAtTime(freq * 0.62, t0 + dur);
  g.gain.setValueAtTime(gain * S.volume, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
function sweep(f0, f1, dur, type, gain) {
  const a = actx; if (!a || S.volume <= 0 || S.muted) return;
  const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime;
  o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(gain * S.volume, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
let noiseBuf = null;
function noiseBurst(dur, freq, q, gain) {
  const a = actx; if (!a || S.volume <= 0 || S.muted) return;
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, Math.floor(a.sampleRate * 0.1), a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t0 = a.currentTime;
  src.buffer = noiseBuf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(gain * S.volume, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(a.destination); src.start(t0); src.stop(t0 + dur + 0.02);
}
// Hit sounds: short, synthesized on the fly (nothing to download). g = relative loudness, p = pitch.
const HIT_SOUNDS = {
  pop: { label: 'Pop', play: (g, p) => blip(900 * p, 0.09, 'triangle', 0.4 * g) },
  soft: { label: 'Soft tick', play: (g, p) => blip(1500 * p, 0.025, 'square', 0.05 * g) },
  click: { label: 'Click', play: (g, p) => noiseBurst(0.022, 3800 * p, 1.4, 1.6 * g) },
  tap: { label: 'Tap', play: (g, p) => sweep(320 * p, 140 * p, 0.06, 'sine', 0.8 * g) },
  tick: { label: 'Tick', play: (g, p) => blip(2400 * p, 0.018, 'square', 0.16 * g) },
  bubble: { label: 'Bubble', play: (g, p) => sweep(420 * p, 1300 * p, 0.07, 'sine', 0.45 * g) },
  snap: { label: 'Snap', play: (g, p) => { noiseBurst(0.015, 6000 * p, 0.9, 1.1 * g); blip(1600 * p, 0.03, 'triangle', 0.25 * g); } },
};
const playSound = (key, loud) => { const snd = HIT_SOUNDS[key]; if (snd) snd.play(loud, 1); };
const sfx = {
  kill: () => playSound(S.hitSound, 1),
  // tracking ticks repeat ~13×/s while on target, so they play quieter than kills
  tick: () => playSound(S.trackSound, S.trackSound === 'soft' ? 1 : 0.35),
  count: () => blip(520, 0.12, 'sine', 0.35),
  go: () => blip(1040, 0.22, 'sine', 0.4),
};

// ---------- leaderboard (prototype: local + simulated field) ----------
function simulateField(key, scn) {
  // Stand-in for real players until the backend exists. Deterministic per day + scenario.
  const rng = mulberry32(hashStr('field:' + key + ':' + scn.id));
  const n = 600 + Math.floor(rng() * 900);
  const mean = scn.pop[0] * (0.95 + rng() * 0.1), sd = scn.pop[1] * (0.9 + rng() * 0.2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const z = gauss(rng);
    let v = mean + sd * z + (z > 0 ? sd * 0.08 * z * z : 0); // slight right tail
    v = clamp(v, 0, scn.max * 0.92);
    out.push(scn.decimals ? Math.round(v * 10) / 10 : Math.round(v));
  }
  return out;
}

// Leaderboard client. Online: the Worker API on this same site. Offline (the file opened
// directly, or the API unreachable): a simulated field, so the game still works for testing.
const MIN_FIELD_FOR_CURVE = 20; // fewer real players than this: no bell curve yet
const PLAYER_ID = (() => {
  let id = store.get('pid', null);
  if (typeof id !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    store.set('pid', id);
  }
  return id;
})();
const apiAvailable = location.protocol === 'http:' || location.protocol === 'https:';
const Board = {
  online: apiAvailable ? null : false, // null = not tried yet
  async today() {
    if (this.online === false) return null;
    try {
      const r = await fetch('/api/today', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      this.online = true; return await r.json();
    } catch (e) { this.online = false; return null; }
  },
  // -> { real, scores }
  async field(key, scn) {
    if (this.online !== false) {
      try {
        const r = await fetch(`/api/scores?day=${encodeURIComponent(key)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        const d = await r.json(); this.online = true;
        return { real: true, count: d.count, scores: d.scores };
      } catch (e) { this.online = false; }
    }
    const local = store.get(`board:${key}:${scn.id}`, []).map((e) => e.score);
    const sim = simulateField(key, scn).concat(local);
    return { real: false, count: sim.length, scores: sim };
  },
  // -> { ok, reason?, already?, offline? }
  async submit(run, scn, today) {
    const v = validateRun(run, scn, today);
    if (!v.ok) return v;
    if (this.online !== false) {
      try {
        const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: PLAYER_ID, run }) });
        const d = await r.json();
        this.online = true;
        if (d.already) { if (d.score != null) store.set('official:' + run.dayKey, { score: d.score, scenarioId: scn.id }); return { ok: false, already: true, score: d.score, reason: d.reason }; }
        if (!d.ok) return { ok: false, reason: d.reason || 'The leaderboard could not save this run.' };
        store.set('official:' + run.dayKey, { score: run.score, scenarioId: scn.id });
        return { ok: true };
      } catch (e) { this.online = false; }
    }
    // offline: keep the score on this device only
    const k = `board:${run.dayKey}:${scn.id}`;
    const list = store.get(k, []);
    list.push({ score: run.score, at: Date.now() });
    store.set(k, list);
    store.set('official:' + run.dayKey, { score: run.score, scenarioId: scn.id });
    return { ok: true, offline: true };
  },
};
const officialToday = () => store.get('official:' + G.daily.key, null);

// ---------- results ----------
function endChallenge() {
  G.stats.activeMs = Math.min(G.stats.activeMs, 60400);
  G.state = 'results'; G.firing = false;
  const s = JSON.parse(JSON.stringify(G.stats));
  const score = SCORE[G.scn.score](s);
  G.run = { v: 1, dayKey: G.daily.key, scenarioId: G.scn.id, score: G.scn.decimals ? Math.round(score * 10) / 10 : Math.round(score), stats: s };
  G.run.stats.damage = s.damage; // keep raw values for validation
  if (document.pointerLockElement) document.exitPointerLock();
  showResults();
}

function niceStep(range, n) { const raw = range / n; const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }
function drawCurve(scores, you, scn) {
  const W = 720, x0 = 12, x1 = 708, yTop = 18, yBase = 158;
  const sorted = scores.slice().sort((a, b) => a - b);
  const n = sorted.length, mean = sorted.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  const step = niceStep(Math.max(sorted[n - 1], you) * 1.05, 7);
  const lo = 0, hi = Math.ceil(Math.max(sorted[n - 1], you, mean + 3 * sd) / step) * step;
  const bw = 1.06 * sd * Math.pow(n, -0.2);
  const X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
  const N = 160, dens = [];
  for (let i = 0; i <= N; i++) {
    const v = lo + ((hi - lo) * i) / N; let d = 0;
    for (const s of sorted) { const u = (v - s) / bw; if (u > -4 && u < 4) d += Math.exp(-0.5 * u * u); }
    dens.push([v, d]);
  }
  const dMax = Math.max(...dens.map((d) => d[1])) || 1;
  const Y = (d) => yBase - (d / dMax) * (yBase - yTop);
  const pts = dens.map(([v, d]) => `${X(v).toFixed(1)},${Y(d).toFixed(1)}`);
  const line = 'M' + pts.join('L');
  const area = `${line}L${X(hi).toFixed(1)},${yBase}L${X(lo).toFixed(1)},${yBase}Z`;
  const youD = (() => { let d = 0; for (const s of sorted) { const u = (you - s) / bw; if (u > -4 && u < 4) d += Math.exp(-0.5 * u * u); } return d; })();
  const yx = X(you), yy = Y(youD);
  let ticks = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const x = X(v);
    ticks += `<line x1="${x}" x2="${x}" y1="${yBase}" y2="${yBase + 6}" stroke="var(--line-strong)"/>`;
    if (Math.abs(x - yx) > 30) ticks += `<text x="${x}" y="${yBase + 24}" text-anchor="middle" fill="var(--muted)" font-family="var(--mono)" font-size="12">${fmtInt(v)}</text>`;
  }
  $('#res-curve').innerHTML = `
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <line x1="${x0}" x2="${x1}" y1="${yBase}" y2="${yBase}" stroke="var(--line-strong)"/>
    ${ticks}
    <path d="${area}" fill="url(#cg)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <line x1="${yx}" x2="${yx}" y1="${yy}" y2="${yBase}" stroke="var(--you)" stroke-width="2"/>
    <circle cx="${yx}" cy="${yy}" r="6" fill="var(--you)" stroke="var(--sheet)" stroke-width="2"/>
    <text x="${yx}" y="${yBase + 24}" text-anchor="middle" fill="var(--you)" font-family="var(--display)" font-weight="700" font-size="14" letter-spacing="2">YOU</text>`;
}

async function renderStanding(score, includeSelf) {
  const scn = G.scn;
  // The field includes this run only after it has been submitted.
  const f = await Board.field(G.daily.key, scn);
  const field = f.scores, wrap = $('#res-curve').parentElement;
  if (f.real && f.count - (includeSelf ? 1 : 0) < MIN_FIELD_FOR_CURVE) {
    wrap.hidden = true;
    $('#res-pct').textContent = 'You are one of the first players today';
    $('#res-field').textContent = "Today's bell curve appears once more players have finished this scene. Check back later.";
    return;
  }
  wrap.hidden = false;
  const others = field.length - (includeSelf ? 1 : 0);
  const below = field.filter((v) => v < score).length;
  const pct = Math.floor((below / Math.max(1, others)) * 100);
  const rank = field.filter((v) => v > score).length + 1;
  drawCurve(field, score, scn);
  $('#res-pct').textContent = rank === 1 ? "Top score of today's players" : `Better than ${clamp(pct, 0, 99)}% of today's players`;
  $('#res-field').textContent = f.real ? '' : "Offline: other players' scores are simulated.";
}

function statCells(s, scn) {
  const sec = s.activeMs / 1000;
  const cells = [['Kills', s.kills]];
  if (s.clickShots) cells.push(['Click accuracy', ((s.clickHits / s.clickShots) * 100).toFixed(1) + '%']);
  if (s.trackFire > 0.05) cells.push(['On target', ((s.trackOn / s.trackFire) * 100).toFixed(1) + '%']);
  if (scn.kind !== 'click') cells.push(['Damage', fmtInt(s.damage)]);
  cells.push(['KPS', (s.kills / sec).toFixed(2)]);
  if (s.kills) cells.push(['Avg TTK', (sec / s.kills).toFixed(2) + 's']);
  return cells.slice(0, 4).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function showResults() {
  const scn = G.scn, run = G.run, off = officialToday();
  $('#scrim').hidden = false; $('#menu').hidden = true; $('#results').hidden = false;
  $('#res-day').textContent = `${new Date(G.daily.day * DAY_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} · complete`;
  $('#res-scn').textContent = sceneTag(G.scnIdx).toUpperCase();
  $('#res-score').textContent = fmtScore(scn, run.score);
  $('#res-unit').textContent = scn.unit;
  $('#res-stats').innerHTML = statCells(run.stats, scn);
  const msg = $('#res-msg'); msg.className = ''; msg.textContent = '';
  setTimeout(() => $('#res-free').focus(), 30);
  if (off) {
    msg.className = 'info';
    msg.textContent = `Practice run, not submitted. Your ranked score today is ${fmtScore(scn, off.score)}.`;
    renderStanding(run.score, false);
    return;
  }
  // first ranked run of the day: submitted automatically, no name needed
  Board.submit(run, scn, G.daily).then((r) => {
    if (r.ok && r.offline) { msg.className = 'info'; msg.textContent = "Saved on this device only. The online leaderboard couldn't be reached."; }
    else if (r.ok) { msg.className = 'ok'; msg.textContent = "Saved as your ranked score for today's challenge."; }
    else if (r.already) { msg.className = 'info'; msg.textContent = `You already have a ranked score today${r.score != null ? ` (${fmtScore(scn, r.score)})` : ''}. This run is practice.`; }
    else { msg.className = 'bad'; msg.textContent = 'Score rejected. ' + r.reason; }
    renderStanding(run.score, r.ok);
  });
}
$('#res-free').addEventListener('click', () => { loadScenario(G.daily.idx, 'free'); startCountdown('free'); });
$('#res-menu').addEventListener('click', () => { loadScenario(G.daily.idx, 'free'); G.state = 'intro'; openMenu(); });
$('#res-copy').addEventListener('click', async () => {
  const txt = `aimdle.io · ${sceneTag(G.scnIdx)}\nScore ${fmtScore(G.scn, G.run.score)} · ${$('#res-pct').textContent.toLowerCase()}`;
  const btn = $('#res-copy');
  try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied'; }
  catch (err) { $('#res-msg').className = 'info'; $('#res-msg').textContent = txt; btn.textContent = 'Copy the text above'; }
  setTimeout(() => { btn.textContent = 'Copy result'; }, 1800);
});

// ---------- menu ----------
function hideSheets() { $('#scrim').hidden = true; }
function showMenuNote(text) { const el = $('#m-status'); el.textContent = text; el.classList.add('warn'); }
function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

function openMenu() {
  // pick up a UTC rollover that happened while the page was open
  const now = dailyInfo();
  if (now.day !== G.daily.day && G.state !== 'paused') { G.daily = now; loadScenario(now.idx, 'free'); }
  $('#scrim').hidden = false; $('#results').hidden = true; $('#menu').hidden = false;
  const d = G.daily, scn = SCENARIOS[d.idx];
  const date = new Date(d.day * DAY_MS).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  $('#m-day').textContent = `${date} · UTC`;
  const showing = G.state === 'paused' ? G.scn : scn;
  const isDaily = showing === scn;
  $('#m-scn-eyebrow').textContent = `${isDaily ? "Today's challenge" : 'Free play'} · Scene #${SCENARIOS.indexOf(showing) + 1}`;
  $('#m-scn').textContent = showing.name;
  $('#m-desc').textContent = showing.desc;
  $('#m-facts').innerHTML = showing.tags.map((t) => `<li>${t}</li>`).join('');
  $('#m-score').textContent = SCORE_TEXT[showing.score] + (isDaily ? ' · 60-second ranked run' : ' · free play only');
  const st = $('#m-status'); st.classList.remove('warn');
  const off = officialToday();
  const p = $('#b-primary'), sec = $('#b-secondary');
  if (G.state === 'paused' && G.resumeTo === 'challenge') {
    st.innerHTML = `Ranked run paused at <b>${(60 - G.stats.activeMs / 1000).toFixed(1)}s</b> left. Resuming starts a 3-second countdown.`;
    p.textContent = 'Resume challenge'; sec.textContent = 'Abandon run'; sec.className = 'btn danger';
  } else {
    st.innerHTML = off
      ? `Ranked score today: <b>${fmtScore(scn, off.score)}</b>. Extra runs are practice and won't be submitted.`
      : `You have one ranked run today. Warm up in free play first; the ranked run starts from this menu.`;
    p.textContent = G.state === 'paused' ? 'Resume free play' : 'Start free play';
    sec.textContent = off ? 'Run challenge again (practice)' : 'Start ranked challenge';
    sec.className = 'btn';
  }
  tickNext();
  syncSettingsUI();
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
$('#b-primary').addEventListener('click', () => {
  if (G.state === 'paused' && G.resumeTo === 'challenge') { startCountdown('challenge'); return; }
  if (G.state !== 'paused') loadScenario(G.daily.idx, 'free');
  startCountdown('free');
});
$('#b-secondary').addEventListener('click', () => {
  if (G.state === 'paused' && G.resumeTo === 'challenge') { loadScenario(G.daily.idx, 'free'); G.state = 'intro'; openMenu(); return; }
  G.daily = dailyInfo();
  loadScenario(G.daily.idx, 'challenge');
  startCountdown('challenge');
});
$('#b-other').innerHTML = SCENARIOS.map((s, i) => `<option value="${i}">${escapeHtml(sceneTag(i))}</option>`).join('');
$('#b-other-go').addEventListener('click', () => { loadScenario(Number($('#b-other').value), 'free'); startCountdown('free'); });

function tickNext() {
  const ms = (utcDay() + 1) * DAY_MS - Date.now();
  const t = Math.max(0, Math.floor(ms / 1000));
  $('#m-next').textContent = `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}`;
}
setInterval(() => { if (!$('#scrim').hidden) tickNext(); }, 1000);

// settings bindings
function syncSettingsUI() {
  $('#set-game').value = S.game;
  $('#row-sens').hidden = S.game === 'custom'; $('#row-cm').hidden = S.game !== 'custom';
  $('#lbl-sens').textContent = GAMES[S.game].sensLabel || 'Sensitivity';
  $('#set-sens').value = S.sens; $('#set-cm').value = S.cm360; $('#set-dpi').value = S.dpi;
  $('#set-fov').value = S.fov; $('#set-fov-out').textContent = S.fov.toFixed(2) + '°';
  $('#set-fovgame').checked = S.fovFromGame; $('#set-fovgame').disabled = S.game === 'custom';
  $('#set-fov').disabled = S.fovFromGame && S.game !== 'custom';
  $('#out-cm').textContent = cmPer360().toFixed(1);
  $('#out-deg').textContent = degPerCount().toFixed(4);
  $('#out-fov').textContent = S.fov.toFixed(1) + '°';
  $('#out-raw').textContent = G.rawInput == null ? 'Not yet' : G.rawInput ? 'On' : 'Off';
  $('#out-hz').textContent = MI.hz ? MI.hz : '–';
  $('#out-step').textContent = MI.step == null ? '–' : (MI.fractional ? MI.step.toFixed(2) : MI.step);
  $('#set-boxroom').checked = !!S.boxRoom; $('#set-input').value = S.inputSrc; $('#set-hitsound').value = S.hitSound; $('#set-tracksound').value = S.trackSound; $('#set-muted').checked = S.muted;
  paintMute(); $('#set-raw').value = S.rawMode; $('#set-scale').value = String(S.renderScale); $('#set-smooth').value = String(S.smoothing);
  $('#set-xh-style').value = S.xhStyle; $('#set-xh-color').value = S.xhColor; $('#set-target-color').value = S.targetColor;
  [['xh-size', 'xhSize'], ['xh-thick', 'xhThick'], ['xh-gap', 'xhGap']].forEach(([id, k]) => { $('#set-' + id).value = S[k]; $('#o-' + id).textContent = S[k] + 'px'; });
  $('#set-xh-outline').checked = S.xhOutline; $('#set-hitmarker').checked = S.hitmarker;
  $('#set-volume').value = S.volume; $('#o-volume').textContent = Math.round(S.volume * 100) + '%';
}
function changed() { saveSettings(); syncSettingsUI(); applyFov(); renderCrosshair(); setHudVisibility(); }
$('#set-game').addEventListener('change', (e) => {
  const prevCm = cmPer360();
  S.game = e.target.value;
  if (S.game === 'custom') S.cm360 = Math.round(prevCm * 10) / 10;
  else {
    S.sens = Math.round(((360 / ((prevCm / 2.54) * S.dpi)) / GAMES[S.game].yaw) * 1000) / 1000; // keep the same physical sensitivity
    if (S.fovFromGame) S.fov = GAMES[S.game].fov;
  }
  changed();
});
$('#set-sens').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v > 0) { S.sens = v; saveSettings(); $('#out-cm').textContent = cmPer360().toFixed(1); $('#out-deg').textContent = degPerCount().toFixed(4); } });
$('#set-cm').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v >= 1) { S.cm360 = v; saveSettings(); $('#out-cm').textContent = cmPer360().toFixed(1); $('#out-deg').textContent = degPerCount().toFixed(4); } });
$('#set-dpi').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v >= 100) { S.dpi = v; saveSettings(); $('#out-cm').textContent = cmPer360().toFixed(1); $('#out-deg').textContent = degPerCount().toFixed(4); } });
$('#set-fov').addEventListener('input', (e) => { S.fov = parseFloat(e.target.value); changed(); });
$('#set-fovgame').addEventListener('change', (e) => { S.fovFromGame = e.target.checked; if (S.fovFromGame && GAMES[S.game].fov) S.fov = GAMES[S.game].fov; changed(); });
$('#set-smooth').addEventListener('change', (e) => { S.smoothing = parseFloat(e.target.value); G.pendX = G.pendY = 0; changed(); });
$('#set-boxroom').addEventListener('change', (e) => { S.boxRoom = e.target.checked; saveSettings(); applyRoomStyle(); });
$('#set-input').addEventListener('change', (e) => { S.inputSrc = e.target.value; G.pendX = G.pendY = 0; changed(); });
$('#set-raw').addEventListener('change', (e) => { S.rawMode = e.target.value; changed(); });
$('#set-scale').addEventListener('change', (e) => { S.renderScale = parseFloat(e.target.value); changed(); resize(); });
$('#set-xh-style').addEventListener('change', (e) => { S.xhStyle = e.target.value; changed(); });
$('#set-xh-color').addEventListener('input', (e) => { S.xhColor = e.target.value; changed(); });
$('#set-target-color').addEventListener('input', (e) => {
  S.targetColor = e.target.value; changed();
  const c = new THREE.Color(S.targetColor);
  G.targets.forEach((t) => { if (!t.fixedColor) t.mat.color.copy(c); });
});
[['xh-size', 'xhSize'], ['xh-thick', 'xhThick'], ['xh-gap', 'xhGap']].forEach(([id, k]) => $('#set-' + id).addEventListener('input', (e) => { S[k] = parseInt(e.target.value, 10); changed(); }));
$('#set-xh-outline').addEventListener('change', (e) => { S.xhOutline = e.target.checked; changed(); });
$('#set-hitmarker').addEventListener('change', (e) => { S.hitmarker = e.target.checked; changed(); });
$('#set-volume').addEventListener('input', (e) => { S.volume = parseFloat(e.target.value); changed(); });
$('#set-volume').addEventListener('change', () => { ac(); sfx.kill(); });
const soundOpts = (def) => Object.entries(HIT_SOUNDS).map(([k, v]) => `<option value="${k}">${v.label}${k === def ? ' (default)' : ''}</option>`).join('') + '<option value="off">Off</option>';
$('#set-hitsound').innerHTML = soundOpts('pop');
$('#set-tracksound').innerHTML = soundOpts('soft');
$('#set-hitsound').addEventListener('change', (e) => { S.hitSound = e.target.value; changed(); ac(); sfx.kill(); });
$('#set-tracksound').addEventListener('change', (e) => { S.trackSound = e.target.value; changed(); ac(); sfx.tick(); });
const SPK_ON = '<svg class="spk" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h3.5L12 5v14l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>', SPK_OFF = '<svg class="spk" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h3.5L11 5v14l-4.5-4H3z" fill="currentColor"/><circle cx="17.5" cy="12" r="5.2" fill="none" stroke="#ff4d4d" stroke-width="2"/><path d="M13.9 15.6l7.2-7.2" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/></svg>';
function paintMute() {
  const m = !!S.muted, b = $('#m-mute');
  b.innerHTML = (m ? SPK_OFF : SPK_ON) + `<span>${m ? 'Sound off' : 'Sound on'}</span>`;
  b.setAttribute('aria-pressed', String(m)); b.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
  $('#set-muted').checked = m; $('#hud-muted').hidden = !m;
}
function setMuted(m) { S.muted = m; saveSettings(); paintMute(); }
$('#set-muted').addEventListener('change', (e) => setMuted(e.target.checked));
$('#m-mute').addEventListener('click', () => setMuted(!S.muted));

$('#hud-toggles').innerHTML = HUD_ITEMS.map(([k, label]) => `<label class="check"><input type="checkbox" id="hud-t-${k}" data-k="${k}"> ${label}</label>`).join('');
HUD_ITEMS.forEach(([k]) => { const el = $('#hud-t-' + k); el.checked = !!S.hud[k]; el.addEventListener('change', () => { S.hud[k] = el.checked; changed(); }); });

// ---------- boot ----------
resize();
loadScenario(G.daily.idx, 'free');
syncSettingsUI();
renderCrosshair();
openMenu();
requestAnimationFrame(frame);
// Use the server's date for today's scene, in case this computer's clock is off.
Board.today().then((t) => {
  if (!t || t.day === G.daily.key) return;
  G.daily = dailyInfo(Math.floor(Date.parse(t.day + 'T00:00:00Z') / DAY_MS));
  if (G.state === 'intro') { loadScenario(G.daily.idx, 'free'); openMenu(); }
});
