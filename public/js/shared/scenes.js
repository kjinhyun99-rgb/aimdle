import { clamp, lerp, fmtInt } from './util.js';

// Scene definitions (Scene #N = position in SCENARIOS). Shared by the game and the Worker:
// the Worker only reads ids, kinds and scoring; build() runs in the browser.
export const sceneTag = (idx) => `Scene #${idx + 1} | ${SCENARIOS[idx].name}`;
// The player is always at the exact center of the room (x, y and z), so targets sit above,
// below and to both sides of the crosshair.
export const DPS = 100; // tracking damage per second on target; tracking score = damage
export const SCORE = {
  kills: (s) => s.kills,
  killsAcc: (s) => s.kills * (s.clickShots ? s.clickHits / s.clickShots : 1),
  killsSqrtAcc: (s) => s.kills * Math.sqrt(s.clickShots ? s.clickHits / s.clickShots : 1),
  damage: (s) => s.damage,
  sandbox: (s) => s.damage + s.sphereKills * 50,
};

export function rectSpot(c, rect, avoid, minSep) {
  let p = null;
  for (let i = 0; i < 80; i++) {
    p = { x: lerp(rect.x0, rect.x1, c.rng()), y: lerp(rect.y0, rect.y1, c.rng()) };
    if (avoid.every((a) => Math.hypot(a.x - p.x, a.y - p.y) >= minSep)) return p;
  }
  return p;
}
// The whole front wall minus a margin, so a target can never clip into the floor, ceiling or side walls.
export const wallRect = (room, m) => ({ x0: -room.w / 2 + m, x1: room.w / 2 - m, y0: m, y1: room.h - m });

// N static spheres spread over one wall; a killed target respawns somewhere else on the wall.
export function wallTargets({ count, r, depth, margin, minSep }) {
  return (c) => {
    const rect = wallRect(c.room, margin), z = c.room.front + depth;
    const live = [];
    const spawn = (exclude) => {
      const avoid = live.map((t) => t.mesh.position).concat(exclude ? [exclude] : []);
      const p = rectSpot(c, rect, avoid, minSep);
      live.push(c.addSphere(p.x, p.y, z, r));
    };
    for (let i = 0; i < count; i++) spawn();
    return {
      onClickKill(t) { const pos = t.mesh.position.clone(); c.remove(t); live.splice(live.indexOf(t), 1); spawn(pos); },
    };
  };
}

// A strafing movement model shared by the tracking bots.
export function makeStrafer(rng, o) {
  const s = { x: o.x ?? (o.xMin + o.xMax) / 2, vx: 0, tv: 0, t: 0, y: 0, vy: 0 };
  s.update = (dt) => {
    s.t -= dt;
    if (s.t <= 0) {
      let dir = rng() < 0.5 ? -1 : 1;
      const rel = (s.x - o.xMin) / (o.xMax - o.xMin);
      if (rel < 0.15) dir = 1; else if (rel > 0.85) dir = -1;
      else if (o.preferFlip && Math.sign(s.tv) !== 0 && rng() < o.preferFlip) dir = -Math.sign(s.tv);
      if (o.stopChance && rng() < o.stopChance) { s.tv = 0; s.t = lerp(0.08, 0.28, rng()); }
      else { s.tv = dir * lerp(o.speed[0], o.speed[1], rng()); s.t = lerp(o.dur[0], o.dur[1], rng()); }
      if (o.jumpChance && s.y === 0 && rng() < o.jumpChance) s.vy = o.jumpV || 6.4;
    }
    const m = o.accel * dt;
    s.vx += clamp(s.tv - s.vx, -m, m);
    s.x += s.vx * dt;
    if (s.x < o.xMin) { s.x = o.xMin; s.vx = 0; s.tv = Math.abs(s.tv); }
    if (s.x > o.xMax) { s.x = o.xMax; s.vx = 0; s.tv = -Math.abs(s.tv); }
    if (s.vy !== 0 || s.y > 0) { s.vy -= 20 * dt; s.y += s.vy * dt; if (s.y <= 0) { s.y = 0; s.vy = 0; } }
  };
  return s;
}

// Sandbox map (from the reference): a raised ledge across the back of the room,
// a wide staircase up to it on the right, and a second flight on the ledge at the back left.
export const SANDBOX_PROPS = (() => {
  const p = [{ x0: -15, x1: 15, y1: 2, z0: -30, z1: -12 }];
  const N = 7;
  for (let i = 0; i < N; i++) p.push({ x0: 2, x1: 10, y1: (2 * (i + 1)) / (N + 1), z0: -12, z1: -12 + (N - i) * 0.7 });
  const M = 6;
  for (let i = 0; i < M; i++) p.push({ x0: -14, x1: -7, y1: 2 + (2.4 * (i + 1)) / M, z0: -30, z1: -24 - i * 0.9 });
  return p;
})();

// Smooth 3D wanderer: steers toward random waypoints inside a box (floating heads, spheres, dots).
export function makeWanderer(rng, b, o) {
  const s = { x: lerp(b.x0, b.x1, rng()), y: lerp(b.y0, b.y1, rng()), z: lerp(b.z0, b.z1, rng()), vx: 0, vy: 0, vz: 0, t: 0 };
  const pick = () => { s.tx = lerp(b.x0, b.x1, rng()); s.ty = lerp(b.y0, b.y1, rng()); s.tz = lerp(b.z0, b.z1, rng()); s.t = lerp(o.retarget[0], o.retarget[1], rng()); s.sp = lerp(o.speed[0], o.speed[1], rng()); };
  pick();
  s.update = (dt) => {
    s.t -= dt;
    if (s.t <= 0 || Math.hypot(s.tx - s.x, s.ty - s.y, s.tz - s.z) < 0.5) pick();
    const dx = s.tx - s.x, dy = s.ty - s.y, dz = s.tz - s.z, d = Math.hypot(dx, dy, dz) || 1, k = o.accel * dt;
    s.vx += clamp((dx / d) * s.sp - s.vx, -k, k); s.vy += clamp((dy / d) * s.sp - s.vy, -k, k); s.vz += clamp((dz / d) * s.sp - s.vz, -k, k);
    s.x = clamp(s.x + s.vx * dt, b.x0, b.x1); s.y = clamp(s.y + s.vy * dt, b.y0, b.y1); s.z = clamp(s.z + s.vz * dt, b.z0, b.z1);
  };
  return s;
}
// Straight-line bouncer inside a box; a box with z0 === z1 keeps it flat on a wall.
export function makeBouncer(rng, b, speed) {
  const a = rng() * Math.PI * 2, e = b.z0 === b.z1 ? 0 : (rng() - 0.5) * 1.2, sp = lerp(speed[0], speed[1], rng());
  const s = { x: lerp(b.x0, b.x1, rng()), y: lerp(b.y0, b.y1, rng()), z: lerp(b.z0, b.z1, rng()), vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(a) * Math.cos(e) * sp, vz: Math.sin(e) * sp };
  s.update = (dt) => {
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    if (s.x < b.x0) { s.x = b.x0; s.vx = Math.abs(s.vx); } if (s.x > b.x1) { s.x = b.x1; s.vx = -Math.abs(s.vx); }
    if (s.y < b.y0) { s.y = b.y0; s.vy = Math.abs(s.vy); } if (s.y > b.y1) { s.y = b.y1; s.vy = -Math.abs(s.vy); }
    if (s.z < b.z0) { s.z = b.z0; s.vz = Math.abs(s.vz); } if (s.z > b.z1) { s.z = b.z1; s.vz = -Math.abs(s.vz); }
  };
  return s;
}

// Scene numbers: a scenario's position in this list (Scene #1 = Sandbox). Append new scenes at the end.
export const SCENARIOS = [
  {
    id: 'sandbox', name: 'Sandbox', short: 'Sandbox', kind: 'mixed', score: 'sandbox',
    desc: 'A mix of hitscan tracking and click timing. Track the bot strafing along the ledge until it dies, then pop three bubbles that appear one at a time, then the bot returns.',
    facts: ['Tracking + clicking', 'Hold to fire on the bot, click the bubbles', '3 bubbles, one at a time', 'Score: damage + 50 per bubble'],
    // ground-level camera, as in the reference; the only room that isn't centered on the player
    room: { w: 30, h: 9, front: -30, eye: 1.7, props: SANDBOX_PROPS }, pop: [2300, 650],
    build(c) {
      const rect = { x0: -10, x1: 10, y0: 3, y1: 6.5 }, foot = 2, bz = -16;
      let bot = null, spheres = [];
      const st = makeStrafer(c.mrng, { xMin: -11, xMax: 11, speed: [5.6, 8.2], dur: [0.4, 1.3], accel: 48 });
      // after the bot dies: 3 spheres, one at a time, each appearing 0.5 s after the previous is popped
      let remaining = 0, wait = 0;
      const spawnBot = () => { st.x = lerp(-6, 6, c.rng()); st.vx = 0; st.t = 0; bot = c.addBot({ r: 0.45, h: 1.9, x: st.x, y: foot, z: bz, hp: 150, ground: foot }); };
      const spawnSphere = () => { const p = rectSpot(c, rect, spheres.map((s) => s.mesh.position), 4); spheres.push(c.addSphere(p.x, p.y, lerp(-22, -14, c.rng()), 0.55)); };
      spawnBot();
      return {
        update(dt) {
          if (bot) { st.update(dt); c.placeBot(bot, st.x, foot + st.y, bz); }
          if (remaining > 0 && !spheres.length) { wait -= dt; if (wait <= 0) { spawnSphere(); remaining--; } }
        },
        onBotKill(t) { c.remove(t); bot = null; remaining = 3; wait = 0.5; },
        onClickKill(t) { c.remove(t); spheres.splice(spheres.indexOf(t), 1); if (remaining > 0) wait = 0.5; else spawnBot(); },
      };
    },
  },
  {
    id: '6-bubbles-mini', name: '6 Bubbles mini', short: '6 Bubbles mini', kind: 'click', score: 'killsSqrtAcc',
    desc: 'One click is one kill. Six tiny bubbles spread across a single wall; every kill respawns one elsewhere. Pure precision.',
    facts: ['Click timing', '6 tiny bubbles', 'Score: kills × √accuracy'],
    room: { w: 36, h: 24, front: -20 }, pop: [68, 17],
    build: wallTargets({ count: 6, r: 0.36, depth: 0.6, margin: 1.5, minSep: 3 }),
  },
  {
    id: 'smooth-strafe-bot', name: 'Smooth strafe bot', short: 'Smooth strafe bot', kind: 'track', score: 'damage',
    desc: 'Mid-range long-strafe tracking. The bot commits to long, steady strafes with smooth direction changes. Stay glued to it.',
    facts: ['Tracking', 'Mid range, long strafes', 'Score: damage (100/s on target)'],
    room: { w: 34, h: 14, front: -20 }, pop: [3300, 800],
    build(c) {
      const foot = c.eye - 0.95;
      const st = makeStrafer(c.mrng, { xMin: -9, xMax: 9, speed: [5.4, 7.8], dur: [1.4, 3.0], accel: 16.8, preferFlip: 0.7 });
      const bot = c.addBot({ r: 0.45, h: 1.9, x: 0, y: foot, z: -13, hp: Infinity });
      return { update(dt) { st.update(dt); c.placeBot(bot, st.x, foot, -13); } };
    },
  },
  {
    id: '6-bubbles', name: '6 Bubbles', short: '6 Bubbles', kind: 'click', score: 'killsAcc',
    desc: 'Six bubbles spread across a wall. Flick between them quickly. Your kills are multiplied by your accuracy, so spraying costs you.',
    facts: ['Click timing', '6 bubbles', 'Score: kills × accuracy'],
    room: { w: 36, h: 24, front: -20 }, pop: [86, 20],
    build: wallTargets({ count: 6, r: 0.65, depth: 0.7, margin: 1.8, minSep: 3.5 }),
  },
  {
    id: '2-bubbles-close', name: '2 Bubbles close', short: '2 Bubbles close', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Flick continuously between two small bubbles. Each new bubble appears a short distance from the one still standing.',
    facts: ['Click timing', '2 small bubbles, short flicks', 'Score: kills × √accuracy'],
    room: { w: 32, h: 22, front: -18 }, pop: [99, 23],
    build(c) {
      const z = c.room.front + 0.6, r = 0.4, rect = wallRect(c.room, 1.5);
      const live = [];
      const near = (o) => {
        for (let i = 0; i < 60; i++) {
          const a = c.rng() * Math.PI * 2, d = lerp(1.4, 3.8, c.rng());
          const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d;
          if (x > rect.x0 && x < rect.x1 && y > rect.y0 && y < rect.y1) return { x, y };
        }
        return { x: clamp(o.x + (o.x > 0 ? -2.5 : 2.5), rect.x0, rect.x1), y: clamp(o.y, rect.y0, rect.y1) };
      };
      // the pair drifts around the whole wall: every few respawns it jumps somewhere new
      let sinceJump = 0;
      const first = rectSpot(c, rect, [], 0);
      live.push(c.addSphere(first.x, first.y, z, r));
      const second = near(first); live.push(c.addSphere(second.x, second.y, z, r));
      return {
        onClickKill(t) {
          c.remove(t); live.splice(live.indexOf(t), 1);
          sinceJump++;
          const anchor = sinceJump > 6 && c.rng() < 0.35 ? (sinceJump = 0, rectSpot(c, rect, [], 0)) : live[0].mesh.position;
          const p = near(anchor);
          live.push(c.addSphere(p.x, p.y, z, r));
        },
      };
    },
  },
  {
    id: '3-cubes', name: '3 Cubes', short: '3 Cubes', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Three cubes on a fixed 4 × 3 grid. Each one respawns the instant it dies, in a different slot. Kill as many as you can.',
    facts: ['Click timing', '3 cubes on a 4 × 3 grid', 'Score: kills × √accuracy'],
    room: { w: 21, h: 13, front: -16 }, pop: [112, 25],
    build(c) {
      const z = -10, size = 1.4;
      const xs = [-5.25, -1.75, 1.75, 5.25], ys = [2.3, -1.2, -4.7].map((d) => c.eye + d);
      const cells = [];
      ys.forEach((y) => xs.forEach((x) => cells.push({ x, y })));
      const occ = new Map(); // target -> cell index
      const spawn = (exclude) => {
        const taken = [...occ.values()];
        const free = cells.map((_, i) => i).filter((i) => i !== exclude && !taken.includes(i));
        const i = free[Math.floor(c.rng() * free.length)];
        occ.set(c.addCube(cells[i].x, cells[i].y, z, size), i);
      };
      for (let k = 0; k < 3; k++) spawn(-1);
      return { onClickKill(t) { const i = occ.get(t); occ.delete(t); c.remove(t); spawn(i); } };
    },
  },
  {
    id: 'thinbot-strafe', name: 'Thinbot strafe', short: 'Thinbot strafe', kind: 'track', score: 'damage',
    desc: 'A thin bot glides along a 180° arc around you at a steady pace and turns back at the edges. Keep it centered. Field of view is at least 103°.',
    facts: ['Tracking', 'Thin bot on a 180° arc', 'Min FOV 103°', 'Score: damage (100/s on target)'],
    room: { w: 34, h: 12, front: -18 }, pop: [4100, 800], fovMin: 103,
    build(c) {
      const R = 11, lim = Math.PI / 2 - 0.06, foot = c.eye - 1.15;
      let th = lerp(-0.4, 0.4, c.rng()), dir = c.rng() < 0.5 ? -1 : 1, t = 0, nextFlip = lerp(3, 6, c.mrng());
      const base = 0.62; // rad/s ≈ 35°/s
      const bot = c.addBot({ r: 0.2, h: 2.3, x: 0, y: foot, z: -R, hp: Infinity });
      return {
        update(dt) {
          t += dt; nextFlip -= dt;
          if (nextFlip <= 0) { dir = -dir; nextFlip = lerp(3, 6, c.mrng()); }
          th += dir * base * (1 + 0.18 * Math.sin(t * 1.3)) * dt;
          if (th > lim) { th = lim; dir = -1; } else if (th < -lim) { th = -lim; dir = 1; }
          c.placeBot(bot, R * Math.sin(th), foot, -R * Math.cos(th));
        },
      };
    },
  },
  {
    id: 'tracking-bot', name: 'Tracking bot', short: 'Tracking bot', kind: 'track', score: 'damage',
    desc: 'Fast, be precise. One quick, twitchy bot at a time, above or below you. Track it until it dies and the next one appears somewhere else.',
    facts: ['Tracking + target switching', '1.2 s of tracking per bot', 'Score: damage (100/s on target)'],
    room: { w: 34, h: 16, front: -20 }, pop: [2700, 750],
    build(c) {
      let bot = null, st = null, z = -12, foot = 0, lastA = 0;
      const spawn = () => {
        let a = 0;
        for (let i = 0; i < 20; i++) { a = lerp(-0.66, 0.66, c.rng()); if (Math.abs(a - lastA) > 0.26) break; }
        lastA = a;
        const d = lerp(10, 13, c.rng()); const x0 = d * Math.sin(a); z = -d * Math.cos(a);
        foot = c.eye - 0.92 + lerp(-3.2, 3.2, c.rng());
        st = makeStrafer(c.mrng, { x: x0, xMin: Math.max(-13, x0 - 4.5), xMax: Math.min(13, x0 + 4.5), speed: [5, 7.2], dur: [0.22, 0.75], accel: 45 });
        bot = c.addBot({ r: 0.42, h: 1.85, x: x0, y: foot, z, hp: 120 });
      };
      spawn();
      return {
        update(dt) { if (bot) { st.update(dt); c.placeBot(bot, st.x, foot + st.y, z); } },
        onBotKill(t) { c.remove(t); bot = null; spawn(); },
      };
    },
  },
  {
    id: '3-bubbles-wide', name: '3 Bubbles wide', short: '3 Bubbles wide', kind: 'click', score: 'kills',
    desc: 'Three small bubbles anywhere on a wide wall. No accuracy multiplier: raw kills only.',
    facts: ['Click timing', '3 small bubbles, ±47° wall', 'Score: kills'],
    room: { w: 35, h: 17.7, front: -16 }, pop: [62, 14],
    build: wallTargets({ count: 3, r: 0.38, depth: 0.4, margin: 1.5, minSep: 6 }),
  },
  {
    id: 'fast-strafe-bot', name: 'Fast strafe bot', short: 'Fast strafe bot', kind: 'track', score: 'damage',
    desc: 'Reactive tracking in a narrow lane. The bot stays on its own short platform and mixes short strafes, sudden stops, quick reversals and hops.',
    facts: ['Reactive tracking', 'Short strafes, stops, hops', 'Score: damage (100/s on target)'],
    room: { w: 24, h: 7.3, front: -12, platform: true }, pop: [2400, 750],
    build(c) {
      const foot = c.eye - 0.94, z = -8, lane = 3, r = 0.35;
      c.addDisc(0, foot, z, 4.6, 0.3); // round platform; the bot's lane (±3) stays well inside it
      const st = makeStrafer(c.mrng, { xMin: -lane, xMax: lane, speed: [4.4, 6.0], dur: [0.25, 0.8], accel: 40, stopChance: 0.06, jumpChance: 0.13, jumpV: 5.5, preferFlip: 0.45 });
      const bot = c.addBot({ r, h: 1.66, x: 0, y: foot, z, hp: Infinity, head: { r: 0.27, gap: 0.05 }, ground: foot });
      return { update(dt) { st.update(dt); c.placeBot(bot, st.x, foot + st.y, z); } };
    },
  },
  // ---------------- Scenes 11–31 ----------------
  {
    id: '5-cubes-180', name: '5 Cubes 180', short: '5 Cubes 180', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Five cubes on a grid that wraps 160° around you. Each one respawns instantly in another slot, so you flick wide in both directions.',
    facts: ['Click timing', '5 cubes on a ±80° grid', 'Score: kills × √accuracy'],
    room: { w: 40, h: 16, front: -20 }, pop: [104, 24],
    build(c) {
      const R = 12, slots = [];
      for (let i = 0; i < 7; i++) { const a = ((-80 + (i * 160) / 6) * Math.PI) / 180; [-3, 0, 3].forEach((dy) => slots.push({ x: R * Math.sin(a), y: c.eye + dy, z: -R * Math.cos(a) })); }
      const occ = new Map();
      const spawn = (ex) => {
        const taken = [...occ.values()];
        const free = slots.map((_, i) => i).filter((i) => i !== ex && !taken.includes(i));
        const i = free[Math.floor(c.rng() * free.length)];
        occ.set(c.addCube(slots[i].x, slots[i].y, slots[i].z, 1.3), i);
      };
      for (let k = 0; k < 5; k++) spawn(-1);
      return { onClickKill(t) { const i = occ.get(t); occ.delete(t); c.remove(t); spawn(i); } };
    },
  },
  {
    id: 'micro-bubbles', name: 'Micro bubbles', short: 'Micro bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Three very small bubbles close together near the middle of the wall. Each new one appears just beside the last. Pure micro-adjustment.',
    facts: ['Click timing', '3 tiny bubbles, tiny flicks', 'Score: kills × √accuracy'],
    room: { w: 30, h: 20, front: -18 }, pop: [84, 22],
    build(c) {
      const z = c.room.front + 0.5, r = 0.22, area = { x0: -4, x1: 4, y0: c.eye - 3, y1: c.eye + 3 };
      const live = [];
      const near = (o) => {
        for (let i = 0; i < 60; i++) {
          const a = c.rng() * Math.PI * 2, d = lerp(0.6, 2, c.rng());
          const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d;
          if (x > area.x0 && x < area.x1 && y > area.y0 && y < area.y1 && live.every((t) => Math.hypot(t.mesh.position.x - x, t.mesh.position.y - y) > 0.7)) return { x, y };
        }
        return rectSpot(c, area, live.map((t) => t.mesh.position), 0.7);
      };
      let p = { x: 0, y: c.eye };
      for (let i = 0; i < 3; i++) { p = near(p); live.push(c.addSphere(p.x, p.y, z, r)); }
      return {
        onClickKill(t) { const pos = t.mesh.position.clone(); c.remove(t); live.splice(live.indexOf(t), 1); const q = near(pos); live.push(c.addSphere(q.x, q.y, z, r)); },
      };
    },
  },
  {
    id: 'shrinking-bubbles', name: 'Shrinking bubbles', short: 'Shrinking bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'One bubble at a time, anywhere on the wall. It shrinks away in 1.3 seconds, so react fast. A missed bubble is simply lost.',
    facts: ['Reaction + click timing', '1 bubble, shrinks in 1.3 s', 'Score: kills × √accuracy'],
    room: { w: 34, h: 22, front: -20 }, pop: [52, 11],
    build(c) {
      const rect = wallRect(c.room, 1.5), z = c.room.front + 0.9, R0 = 0.9, LIFE = 1.3;
      let cur = null, age = 0, last = null;
      const spawn = () => { const p = rectSpot(c, rect, last ? [last] : [], 6); last = p; cur = c.addSphere(p.x, p.y, z, R0); age = 0; };
      spawn();
      return {
        update(dt) {
          age += dt;
          const k = 1 - age / LIFE;
          if (k <= 0.05) { c.remove(cur); spawn(); } else cur.mesh.scale.setScalar(R0 * k);
        },
        onClickKill(t) { c.remove(t); spawn(); },
      };
    },
  },
  {
    id: 'spider-bubbles', name: 'Spider bubbles', short: 'Spider bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Alternate between a bubble in the center and one anywhere on the wall. Flick out, flick back, repeat.',
    facts: ['Click timing', 'Center, then anywhere, then center', 'Score: kills × √accuracy'],
    room: { w: 36, h: 24, front: -20 }, pop: [98, 22],
    build(c) {
      const rect = wallRect(c.room, 1.5), z = c.room.front + 0.7, r = 0.6;
      let center = true;
      const spawn = () => {
        if (center) c.addSphere(0, c.eye, z, r);
        else { const p = rectSpot(c, rect, [{ x: 0, y: c.eye }], 5); c.addSphere(p.x, p.y, z, r); }
      };
      spawn();
      return { onClickKill(t) { c.remove(t); center = !center; spawn(); } };
    },
  },
  {
    id: 'popcorn-bubbles', name: 'Popcorn bubbles', short: 'Popcorn bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Bubbles pop up from the floor at different distances, arc up and fall back down. Catch them in the air before they land.',
    facts: ['Moving targets, click timing', '3 bubbles on gravity arcs', 'Score: kills × √accuracy'],
    room: { w: 30, h: 16, front: -20 }, pop: [68, 17],
    build(c) {
      const GRAV = 9, r = 0.45;
      const items = [0, 0.6, 1.2].map((wait) => ({ t: null, wait }));
      const launch = (it) => {
        it.z = lerp(-17, -5, c.rng()); const half = Math.min(8, -it.z * 0.75); it.x = lerp(-half, half, c.rng()); it.y = r;
        it.vy = lerp(9.5, 12.5, c.rng()); it.vx = lerp(-1.5, 1.5, c.rng());
        it.t = c.addSphere(it.x, it.y, it.z, r);
      };
      return {
        update(dt) {
          for (const it of items) {
            if (!it.t) { it.wait -= dt; if (it.wait <= 0) launch(it); continue; }
            it.vy -= GRAV * dt; it.x += it.vx * dt; it.y += it.vy * dt;
            it.t.mesh.position.set(it.x, it.y, it.z);
            if (it.y < r && it.vy < 0) { c.remove(it.t); it.t = null; it.wait = 0.15; }
          }
        },
        onClickKill(t) { const it = items.find((i) => i.t === t); c.remove(t); it.t = null; it.wait = 0.2; },
      };
    },
  },
  {
    id: 'bouncing-bubbles', name: 'Bouncing bubbles', short: 'Bouncing bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Four bubbles slide across the wall in straight lines and bounce off its edges. Lead them and click.',
    facts: ['Moving targets, click timing', '4 bubbles bouncing on the wall', 'Score: kills × √accuracy'],
    room: { w: 32, h: 22, front: -18 }, pop: [78, 19],
    build(c) {
      const z = c.room.front + 0.6, b = Object.assign(wallRect(c.room, 1.5), { z0: z, z1: z });
      const items = [];
      const add = () => { const m = makeBouncer(c.rng, b, [5.04, 9.36]); items.push({ m, t: c.addSphere(m.x, m.y, m.z, 0.41) }); };
      for (let i = 0; i < 4; i++) add();
      return {
        update(dt) { items.forEach(({ m, t }) => { m.update(dt); t.mesh.position.set(m.x, m.y, m.z); }); },
        onClickKill(t) { c.remove(t); items.splice(items.findIndex((x) => x.t === t), 1); add(); },
      };
    },
  },
  {
    id: 'drifting-bubbles', name: 'Drifting bubbles', short: 'Drifting bubbles', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Three bubbles drift slowly through the space in front of you, some close and some farther back. Click timing on slow movers at changing depths.',
    facts: ['Moving targets, click timing', '3 drifting bubbles at varied depth', 'Score: kills × √accuracy'],
    room: { w: 30, h: 18, front: -20 }, pop: [76, 18],
    build(c) {
      const b = { x0: -8, x1: 8, y0: c.eye - 4, y1: c.eye + 4, z0: -15, z1: -4 };
      const items = [];
      const add = () => { const m = makeWanderer(c.rng, b, { speed: [2, 3.5], retarget: [1, 2.5], accel: 5 }); items.push({ m, t: c.addSphere(m.x, m.y, m.z, 0.45) }); };
      for (let i = 0; i < 3; i++) add();
      return {
        update(dt) { items.forEach(({ m, t }) => { m.update(dt); t.mesh.position.set(m.x, m.y, m.z); }); },
        onClickKill(t) { c.remove(t); items.splice(items.findIndex((x) => x.t === t), 1); add(); },
      };
    },
  },
  {
    id: 'strafing-cubes', name: 'Strafing cubes', short: 'Strafing cubes', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Three cubes on three rows, each strafing left and right on its own. A killed cube respawns somewhere else on its row.',
    facts: ['Moving targets, click timing', '3 strafing cubes, one per row', 'Score: kills × √accuracy'],
    room: { w: 30, h: 16, front: -18 }, pop: [88, 20],
    build(c) {
      const z = -14;
      const items = [3, 0, -3].map((d) => ({ y: c.eye + d }));
      const spawnRow = (it) => {
        it.s = makeStrafer(c.mrng, { x: lerp(-8, 8, c.rng()), xMin: -9, xMax: 9, speed: [3.75, 6.25], dur: [0.5, 1.4], accel: 31 });
        it.t = c.addCube(it.s.x, it.y, z, 1.2);
      };
      items.forEach(spawnRow);
      return {
        update(dt) { items.forEach((it) => { it.s.update(dt); it.t.mesh.position.set(it.s.x, it.y, z); }); },
        onClickKill(t) { const it = items.find((i) => i.t === t); c.remove(t); spawnRow(it); },
      };
    },
  },
  {
    id: 'bubble-frenzy', name: 'Bubble frenzy', short: 'Bubble frenzy', kind: 'track', score: 'damage',
    desc: 'Three fast bubbles ricochet around the room in all three directions. Each one dies after a short burst of tracking; switch to the next.',
    facts: ['Fast tracking + switching', '3 bouncing bubbles, 0.4 s of tracking each', 'Score: damage (100/s on target)'],
    room: { w: 28, h: 16, front: -18 }, pop: [2300, 700],
    build(c) {
      const b = { x0: -9, x1: 9, y0: 2, y1: c.room.h - 2, z0: -16, z1: -6 };
      const items = [];
      const add = () => { const m = makeBouncer(c.rng, b, [7.5, 11.25]); items.push({ m, t: c.addTrackSphere(m.x, m.y, m.z, 0.7, 40) }); };
      for (let i = 0; i < 3; i++) add();
      return {
        update(dt) { items.forEach(({ m, t }) => { m.update(dt); t.mesh.position.set(m.x, m.y, m.z); }); },
        onBotKill(t) { c.remove(t); items.splice(items.findIndex((x) => x.t === t), 1); add(); },
      };
    },
  },
  {
    id: 'close-strafe-bot', name: 'Close strafe bot', short: 'Close strafe bot', kind: 'track', score: 'damage',
    desc: 'A tough bot right in front of you that strafes, steps toward and away from you, and jumps. Wear down its big health bar; a new one replaces it.',
    facts: ['Reactive tracking', 'Very close: strafes, steps in and out, jumps', '3 s of tracking per bot', 'Score: damage (100/s on target)'],
    room: { w: 24, h: 12, front: -14 }, pop: [3000, 800],
    build(c) {
      const foot = c.eye - 1;
      let bot = null, sx = null, sz = null;
      const spawn = () => {
        sx = makeStrafer(c.mrng, { x: lerp(-3, 3, c.rng()), xMin: -4.5, xMax: 4.5, speed: [6.25, 9.4], dur: [0.3, 0.9], accel: 45, preferFlip: 0.4, jumpChance: 0.15, jumpV: 6 });
        sz = makeStrafer(c.mrng, { x: -4.5, xMin: -6, xMax: -3, speed: [2, 3.5], dur: [0.4, 1.1], accel: 20 });
        bot = c.addBot({ r: 0.5, h: 2, x: sx.x, y: foot, z: sz.x, hp: 300, barScale: 1.6 });
      };
      spawn();
      return {
        update(dt) { if (bot) { sx.update(dt); sz.update(dt); c.placeBot(bot, sx.x, foot + sx.y, sz.x); } },
        onBotKill(t) { c.remove(t); bot = null; spawn(); },
      };
    },
  },
  {
    id: '360-strafe-bubble', name: '360 Strafe bubble', short: '360 Strafe bubble', kind: 'track', score: 'damage',
    desc: 'A bubble that strafes in long, random directions on a sphere around you: over your head, behind you, under your feet. It changes direction instantly. Turn and look up and down to stay on it.',
    facts: ['360° tracking', '1 bubble, long strafes in any direction', 'Score: damage (100/s on target)'],
    room: { w: 24, h: 24, front: -12 }, pop: [2400, 750],
    build(c) {
      // The bubble lives on a sphere of radius R around the player. Each strafe picks a random
      // direction along the surface and holds it for a while; direction changes are instant.
      const R = 10;
      // plain [x, y, z] vector math so this file has no three.js dependency (the Worker imports it)
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
      let p = [0, 0, -1], d = [1, 0, 0], w = 0.6, t = 0;
      const newStrafe = () => {
        let e1 = cross([0, 1, 0], p); if (Math.hypot(...e1) < 1e-2) e1 = [1, 0, 0]; e1 = norm(e1);
        const e2 = norm(cross(p, e1)), phi = c.mrng() * Math.PI * 2, cp = Math.cos(phi), sp = Math.sin(phi);
        d = norm([e1[0] * cp + e2[0] * sp, e1[1] * cp + e2[1] * sp, e1[2] * cp + e2[2] * sp]);
        w = lerp(0.5, 0.7, c.mrng()); t = lerp(1.0, 2.2, c.mrng());
      };
      newStrafe();
      const ball = c.addTrackSphere(0, c.eye, -R, 0.5);
      return {
        update(dt) {
          t -= dt; if (t <= 0) newStrafe();
          // move along the great circle through p in direction d
          const a = w * dt, ca = Math.cos(a), sa = Math.sin(a);
          const np = norm([p[0] * ca + d[0] * sa, p[1] * ca + d[1] * sa, p[2] * ca + d[2] * sa]);
          d = norm([d[0] * ca - p[0] * sa, d[1] * ca - p[1] * sa, d[2] * ca - p[2] * sa]);
          p = np;
          ball.mesh.position.set(R * p[0], c.eye + R * p[1], R * p[2]);
        },
      };
    },
  },
  {
    id: 'air-bot', name: 'Air bot', short: 'Air bot', kind: 'track', score: 'damage',
    desc: 'A bot floating in mid-air that moves sideways, up and down, and toward and away from you at the same time, each on its own rhythm.',
    facts: ['Tracking in three directions', 'Floating bot, mixed movement', 'Score: damage (100/s on target)'],
    room: { w: 28, h: 20, front: -18 }, pop: [2600, 750],
    build(c) {
      const z = -12;
      const sx = makeStrafer(c.mrng, { xMin: -7, xMax: 7, speed: [4.4, 6.9], dur: [0.6, 1.6], accel: 1e4 }); // accel 1e4 = instant direction changes
      const sy = makeStrafer(c.mrng, { x: c.eye - 1, xMin: c.eye - 4, xMax: c.eye + 2, speed: [3.1, 5], dur: [0.6, 1.6], accel: 1e4 });
      const sz = makeStrafer(c.mrng, { x: z, xMin: -15, xMax: -8, speed: [2, 3.5], dur: [0.7, 1.8], accel: 1e4 }); // toward / away
      const bot = c.addBot({ r: 0.45, h: 1.9, x: 0, y: sy.x, z, hp: Infinity });
      return { update(dt) { sx.update(dt); sy.update(dt); sz.update(dt); c.placeBot(bot, sx.x, sy.x, sz.x); } };
    },
  },
  {
    id: 'smooth-spheres', name: 'Smooth spheres', short: 'Smooth spheres', kind: 'track', score: 'damage',
    desc: 'Three spheres gliding on smooth curves at different depths. Track one until its health runs out, then move smoothly to the next.',
    facts: ['Smooth tracking + switching', '3 spheres, 0.75 s of tracking each', 'Score: damage (100/s on target)'],
    room: { w: 26, h: 18, front: -18 }, pop: [2800, 750],
    build(c) {
      const box = { x0: -8, x1: 8, y0: c.eye - 4, y1: c.eye + 4, z0: -14, z1: -7 };
      const items = [];
      const add = () => {
        const m = makeWanderer(c.mrng, box, { speed: [3.5, 5], retarget: [1.2, 2.5], accel: 6 });
        items.push({ m, t: c.addTrackSphere(m.x, m.y, m.z, 0.41, 75) });
      };
      for (let i = 0; i < 3; i++) add();
      return {
        update(dt) { items.forEach(({ m, t }) => { m.update(dt); t.mesh.position.set(m.x, m.y, m.z); }); },
        onBotKill(t) { c.remove(t); items.splice(items.findIndex((x) => x.t === t), 1); add(); },
      };
    },
  },
  {
    id: 'bot-plaza', name: 'Bot plaza', short: 'Bot plaza', kind: 'track', score: 'damage',
    desc: 'Three bots strafing on the floor below you. Track one until it dies, switch to the next, and keep going as they respawn.',
    facts: ['Tracking + target switching', '3 ground bots, 1.2 s of tracking each', 'Score: damage (100/s on target)'],
    room: { w: 32, h: 10, front: -20 }, pop: [2800, 750],
    build(c) {
      const items = [];
      const add = (avoidX) => {
        let x0 = 0;
        for (let i = 0; i < 20; i++) { x0 = lerp(-11, 11, c.rng()); if (items.every((it) => Math.abs(it.s.x - x0) > 4) && (avoidX == null || Math.abs(x0 - avoidX) > 3)) break; }
        const z = lerp(-16, -10, c.rng());
        const s = makeStrafer(c.mrng, { x: x0, xMin: Math.max(-13, x0 - 4), xMax: Math.min(13, x0 + 4), speed: [3.5, 5.5], dur: [0.4, 1.2], accel: 30 });
        items.push({ s, z, b: c.addBot({ r: 0.45, h: 1.9, x: x0, y: 0, z, hp: 120 }) });
      };
      for (let i = 0; i < 3; i++) add();
      return {
        update(dt) { items.forEach((it) => { it.s.update(dt); c.placeBot(it.b, it.s.x, 0, it.z); }); },
        onBotKill(t) { const i = items.findIndex((it) => it.b === t); const x = items[i].s.x; c.remove(t); items.splice(i, 1); add(x); },
      };
    },
  },
  {
    id: 'bounce-bot-180', name: 'Bounce bot 180', short: 'Bounce bot 180', kind: 'track', score: 'damage',
    desc: 'A bot hopping and strafing along a 180° arc around you. Its direction changes are quick and it leaves the ground often.',
    facts: ['Reactive tracking', 'Hops along a 180° arc', 'Score: damage (100/s on target)'],
    room: { w: 30, h: 12, front: -16 }, pop: [2700, 750],
    build(c) {
      const R = 10, foot = c.eye - 1.5, lim = Math.PI / 2 - 0.1;
      let th = 0, w = 0, tw = 0, t = 0, y = 0, vy = 0;
      const bot = c.addBot({ r: 0.4, h: 1.8, x: 0, y: foot, z: -R, hp: Infinity });
      return {
        update(dt) {
          t -= dt;
          if (t <= 0) {
            tw = (c.mrng() < 0.5 ? -1 : 1) * lerp(0.6, 1.0, c.mrng());
            if (th > lim - 0.3) tw = -Math.abs(tw); else if (th < -lim + 0.3) tw = Math.abs(tw);
            t = lerp(0.4, 1.2, c.mrng());
            if (y === 0 && c.mrng() < 0.35) vy = 6.5;
          }
          const k = 4 * dt; w += clamp(tw - w, -k, k); th = clamp(th + w * dt, -lim, lim);
          if (vy !== 0 || y > 0) { vy -= 20 * dt; y += vy * dt; if (y <= 0) { y = 0; vy = 0; } }
          c.placeBot(bot, R * Math.sin(th), foot + y, -R * Math.cos(th));
        },
      };
    },
  },
  {
    id: 'rising-thin-bot', name: 'Rising thin bot', short: 'Rising thin bot', kind: 'track', score: 'damage',
    desc: 'A very thin bot strafing side to side while slowly rising and sinking, so your aim has to drift up and down as you track.',
    facts: ['Precise tracking', 'Thin bot, rises and sinks while strafing', 'Score: damage (100/s on target)'],
    room: { w: 28, h: 16, front: -18 }, pop: [2900, 800],
    build(c) {
      const z = -12, phase = c.mrng() * Math.PI * 2;
      let t = 0;
      const sx = makeStrafer(c.mrng, { xMin: -7, xMax: 7, speed: [4, 6], dur: [0.5, 1.3], accel: 25 });
      const bot = c.addBot({ r: 0.15, h: 2.2, x: 0, y: c.eye - 1, z, hp: Infinity });
      return { update(dt) { t += dt; sx.update(dt); c.placeBot(bot, sx.x, c.eye - 1 + 3.2 * Math.sin(0.55 * t + phase), z); } };
    },
  },
  {
    id: 'thinbot-gauntlet', name: 'Thinbot gauntlet', short: 'Thinbot gauntlet', kind: 'track', score: 'damage',
    desc: 'Thin bots one after another. Track each one until it dies; the next appears somewhere else in front of you.',
    facts: ['Precise tracking + switching', 'Thin bots, 1.5 s of tracking each', 'Score: damage (100/s on target)'],
    room: { w: 30, h: 12, front: -18 }, pop: [2700, 750],
    build(c) {
      let bot = null, st = null, z = -11, lastA = 0;
      const foot = c.eye - 1.15;
      const spawn = () => {
        let a = 0;
        for (let i = 0; i < 20; i++) { a = lerp(-0.7, 0.7, c.rng()); if (Math.abs(a - lastA) > 0.3) break; }
        lastA = a;
        const d = lerp(10, 12, c.rng()); const x0 = d * Math.sin(a); z = -d * Math.cos(a);
        st = makeStrafer(c.mrng, { x: x0, xMin: Math.max(-13, x0 - 3.5), xMax: Math.min(13, x0 + 3.5), speed: [3, 4.5], dur: [0.6, 1.4], accel: 20 });
        bot = c.addBot({ r: 0.2, h: 2.3, x: x0, y: foot, z, hp: 150 });
      };
      spawn();
      return {
        update(dt) { if (bot) { st.update(dt); c.placeBot(bot, st.x, foot, z); } },
        onBotKill(t) { c.remove(t); bot = null; spawn(); },
      };
    },
  },
  {
    id: 'bouncy-balls', name: '5 Bouncy balls', short: '5 Bouncy balls', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Five small balls bouncing on the floor in front of you, each at its own height and rhythm; a few bounce all the way to the ceiling. Time your clicks to their bounces.',
    facts: ['Click timing on bouncing targets', '5 small balls', 'Score: kills × √accuracy'],
    room: { w: 28, h: 12, front: -18 }, pop: [80, 20],
    build(c) {
      const GRAV = 14, r = 0.35, items = [];
      const add = () => {
        const apex = 2.5 + (c.room.h - 0.5 - r - 2.5) * c.rng() ** 1.6; // most bounce low-to-mid, a few reach the ceiling
        const it = { x: lerp(-8, 8, c.rng()), z: lerp(-14, -7, c.rng()), vx: lerp(-1.2, 1.2, c.mrng()), vz: lerp(-0.6, 0.6, c.mrng()), bounceV: Math.sqrt(2 * GRAV * apex) };
        it.y = r + lerp(0.3, 1, c.rng()) * apex; it.vy = 0;
        it.t = c.addSphere(it.x, it.y, it.z, r);
        items.push(it);
      };
      for (let i = 0; i < 5; i++) add();
      return {
        update(dt) {
          for (const it of items) {
            it.vy -= GRAV * dt; it.y += it.vy * dt;
            if (it.y <= r) { it.y = r; it.vy = it.bounceV; }
            it.x += it.vx * dt; it.z += it.vz * dt;
            if (Math.abs(it.x) > 9) { it.x = Math.sign(it.x) * 9; it.vx = -it.vx; }
            if (it.z < -15 || it.z > -6) { it.z = clamp(it.z, -15, -6); it.vz = -it.vz; }
            it.t.mesh.position.set(it.x, it.y, it.z);
          }
        },
        onClickKill(t) { const i = items.findIndex((it) => it.t === t); c.remove(t); items.splice(i, 1); add(); },
      };
    },
  },
  {
    id: 'mini-bubble-track', name: 'Mini bubble track', short: 'Mini bubble track', kind: 'track', score: 'damage',
    desc: 'A tiny bubble drifting slowly and smoothly at close range. The movement is easy; staying exactly on something this small is not.',
    facts: ['Precision tracking', '1 tiny bubble, slow smooth paths', 'Score: damage (100/s on target)'],
    room: { w: 22, h: 14, front: -14 }, pop: [2600, 800],
    build(c) {
      const m = makeWanderer(c.mrng, { x0: -4, x1: 4, y0: c.eye - 2.5, y1: c.eye + 2.5, z0: -10, z1: -7 }, { speed: [2, 3], retarget: [1.2, 2.5], accel: 4 });
      const t = c.addTrackSphere(m.x, m.y, m.z, 0.18);
      return { update(dt) { m.update(dt); t.mesh.position.set(m.x, m.y, m.z); } };
    },
  },
  {
    id: 'leap-bot', name: 'Leap bot', short: 'Leap bot', kind: 'track', score: 'damage',
    desc: 'A distant bot that leaps across its long platform in arcs, pausing briefly between jumps. Follow it through the air and catch the landings.',
    facts: ['Reactive tracking', 'Long jumping arcs', 'Score: damage (100/s on target)'],
    room: { w: 36, h: 14, front: -32 }, pop: [2300, 700],
    build(c) {
      const foot = c.eye - 2, z = -24;
      c.addProp({ x0: -13, x1: 13, y0: foot - 0.3, y1: foot, z0: z - 1.5, z1: z + 1.5 });
      let x = 0, y = 0, vx = 0, vy = 0, t = 0.5;
      const bot = c.addBot({ r: 0.45, h: 1.9, x: 0, y: foot, z, hp: Infinity, ground: foot });
      return {
        update(dt) {
          if (y === 0) {
            t -= dt; vx *= Math.max(0, 1 - 8 * dt);
            if (t <= 0) { const tx = lerp(-11, 11, c.mrng()); vx = clamp((tx - x) / 0.75, -12, 12); vy = 7.5; t = lerp(0.3, 0.9, c.mrng()); }
          }
          if (vy !== 0 || y > 0) { vy -= 20 * dt; y += vy * dt; if (y <= 0) { y = 0; vy = 0; } }
          x = clamp(x + vx * dt, -12, 12);
          c.placeBot(bot, x, foot + y, z);
        },
      };
    },
  },
  {
    id: 'headshot-bot', name: 'Headshot bot', short: 'Headshot bot', kind: 'click', score: 'killsSqrtAcc',
    desc: 'Two bots that step a little, stop, then step again. Only the small white head counts; body shots are misses. Each kill brings a new bot 0.5 s later, usually far away.',
    facts: ['Click timing on a moving head', '2 bots, stop-and-go steps', 'Mostly far, sometimes close', 'Score: kills × √accuracy'],
    room: { w: 36, h: 12, front: -36 }, pop: [58, 15],
    build(c) {
      const foot = c.eye - 1.6, H = 1.7, hr = 0.21, headY = foot + H + 0.05 + hr;
      const slots = [0, 1].map(() => ({ body: c.addBody({ r: 0.4, h: H }), head: null, wait: 0 }));
      const spawn = (sl) => {
        // usually far (careful clicks), sometimes close; keep the two bots apart
        for (let i = 0; i < 20; i++) {
          sl.z = c.rng() < 0.7 ? -lerp(20, 32, c.rng()) : -lerp(7, 13, c.rng());
          sl.half = Math.min(14, -sl.z * 0.55);
          sl.x = lerp(-sl.half * 0.8, sl.half * 0.8, c.rng());
          if (slots.every((o) => o === sl || !o.head || Math.abs(o.x / -o.z - sl.x / -sl.z) > 0.25)) break;
        }
        sl.vx = 0; sl.moving = false; sl.t = lerp(0.2, 0.6, c.mrng());
        sl.body.visible = true; sl.body.position.set(sl.x, foot, sl.z);
        sl.head = c.addSphere(sl.x, headY, sl.z, hr, { color: 0xf2f2f2 });
      };
      slots.forEach(spawn);
      return {
        update(dt) {
          for (const sl of slots) {
            if (!sl.head) { sl.wait -= dt; if (sl.wait <= 0) spawn(sl); continue; }
            // stop-and-go: a short step in one direction, then a pause
            sl.t -= dt;
            if (sl.t <= 0) {
              sl.moving = !sl.moving;
              if (sl.moving) { let dir = c.mrng() < 0.5 ? -1 : 1; if (Math.abs(sl.x) > sl.half * 0.8) dir = -Math.sign(sl.x); sl.vx = dir * lerp(3, 5, c.mrng()); sl.t = lerp(0.2, 0.45, c.mrng()); }
              else { sl.vx = 0; sl.t = lerp(0.3, 0.8, c.mrng()); }
            }
            sl.x = clamp(sl.x + sl.vx * dt, -sl.half, sl.half);
            sl.body.position.set(sl.x, foot, sl.z); sl.head.mesh.position.set(sl.x, headY, sl.z);
          }
        },
        onClickKill(t) { const sl = slots.find((o) => o.head === t); c.remove(t); sl.head = null; sl.body.visible = false; sl.wait = 0.5; },
      };
    },
  },
];
// Menu tags. Fixed vocabulary: tracking, click-timing, bubble, bot, headshot, 180,
// long strafe, short strafe, fast strafe, invincible, flick.
export const TAGS = {
  'sandbox': ['tracking', 'click-timing', 'bot', 'bubble'],
  '6-bubbles-mini': ['click-timing', 'bubble', 'flick'],
  'smooth-strafe-bot': ['tracking', 'bot', 'long strafe', 'invincible'],
  '6-bubbles': ['click-timing', 'bubble', 'flick'],
  '2-bubbles-close': ['click-timing', 'bubble', 'flick'],
  '3-cubes': ['click-timing', 'flick'],
  'thinbot-strafe': ['tracking', 'bot', '180', 'long strafe', 'invincible'],
  'tracking-bot': ['tracking', 'bot', 'short strafe'],
  '3-bubbles-wide': ['click-timing', 'bubble', 'flick'],
  'fast-strafe-bot': ['tracking', 'bot', 'short strafe', 'fast strafe', 'invincible'],
  '5-cubes-180': ['click-timing', '180', 'flick'],
  'micro-bubbles': ['click-timing', 'bubble'],
  'shrinking-bubbles': ['click-timing', 'bubble', 'flick'],
  'spider-bubbles': ['click-timing', 'bubble', 'flick'],
  'popcorn-bubbles': ['click-timing', 'bubble'],
  'bouncing-bubbles': ['click-timing', 'bubble'],
  'drifting-bubbles': ['click-timing', 'bubble'],
  'strafing-cubes': ['click-timing', 'short strafe'],
  'bubble-frenzy': ['tracking', 'bubble'],
  'close-strafe-bot': ['tracking', 'bot', 'short strafe', 'fast strafe'],
  '360-strafe-bubble': ['tracking', 'bubble', 'long strafe', 'invincible'],
  'air-bot': ['tracking', 'bot', 'invincible'],
  'smooth-spheres': ['tracking', 'bubble'],
  'bot-plaza': ['tracking', 'bot', 'short strafe'],
  'bounce-bot-180': ['tracking', 'bot', '180', 'short strafe', 'invincible'],
  'rising-thin-bot': ['tracking', 'bot', 'short strafe', 'invincible'],
  'thinbot-gauntlet': ['tracking', 'bot'],
  'bouncy-balls': ['click-timing', 'bubble'],
  'mini-bubble-track': ['tracking', 'bubble', 'invincible'],
  'leap-bot': ['tracking', 'bot', 'invincible'],
  'headshot-bot': ['click-timing', 'bot', 'headshot'],
};
export const SCORE_TEXT = {
  kills: 'Score: kills', killsAcc: 'Score: kills × accuracy', killsSqrtAcc: 'Score: kills × √accuracy',
  damage: 'Score: damage, 100 per second on target', sandbox: 'Score: damage, plus 50 per bubble',
};
SCENARIOS.forEach((s) => {
  s.tags = TAGS[s.id] || [];
  s.max = s.score === 'damage' ? DPS * 60.6 : s.score === 'sandbox' ? DPS * 60.6 + 50 * 12 * 61 : 12 * 61;
  s.decimals = s.score === 'killsAcc' || s.score === 'killsSqrtAcc' ? 1 : 0;
  s.unit = s.score === 'damage' || s.score === 'sandbox' ? 'points' : s.score === 'killsAcc' ? 'kills × acc' : s.score === 'killsSqrtAcc' ? 'kills × √acc' : 'kills';
  s.room.back = -s.room.front; // player stands at the exact center of every room
});
export const fmtScore = (scn, v) => scn.decimals ? v.toFixed(1) : fmtInt(v);

