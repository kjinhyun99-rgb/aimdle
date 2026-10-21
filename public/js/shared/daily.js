import { mulberry32, hashStr } from './util.js';
import { SCENARIOS } from './scenes.js';

// Daily rotation (UTC). Shared by the game and the Worker so both agree on today's scene.
export const DAY_MS = 86400000;
export const utcDay = (t = Date.now()) => Math.floor(t / DAY_MS);
export const dayKey = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
// Monthly rotation: each UTC month gets its own seeded shuffle of all scenes, and day N of the
// month plays entry N. No scene repeats within a month; shorter months skip the last entries.
export function dailyScenarioIndex(d) {
  const date = new Date(d * DAY_MS);
  const rng = mulberry32(hashStr(`aimdle-month-${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`));
  const p = SCENARIOS.map((_, i) => i);
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p[(date.getUTCDate() - 1) % p.length];
}
export function dailyInfo(d = utcDay()) {
  const idx = dailyScenarioIndex(d);
  return { day: d, key: dayKey(d), idx, scene: idx + 1 };
}

