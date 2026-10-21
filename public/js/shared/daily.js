import { mulberry32, hashStr } from './util.js';
import { SCENARIOS } from './scenes.js';

// Daily rotation. Shared by the game and the Worker so both agree on today's scene.
// The day turns over at midnight Pacific time (PDT in summer, PST in winter).
// A "day number" d is the Pacific calendar date counted as days since 1970-01-01, so
// new Date(d * DAY_MS) read in UTC gives that calendar date.
export const DAY_MS = 86400000;
export const TZ = 'America/Los_Angeles';
const DATE_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' });
export function gameDay(t = Date.now()) {
  const p = Object.fromEntries(DATE_FMT.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS;
}
// Timestamp of the next midnight Pacific after t (07:00 or 08:00 UTC, depending on daylight time).
export function nextReset(t = Date.now()) {
  const d = gameDay(t) + 1;
  for (const h of [7, 8]) { const c = d * DAY_MS + h * 3600000; if (gameDay(c) === d && gameDay(c - 1) === d - 1) return c; }
  return d * DAY_MS + 8 * 3600000;
}
export const dayKey = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
// Monthly rotation: each month gets its own seeded shuffle of all scenes, and day N of the
// month plays entry N. No scene repeats within a month; shorter months skip the last entries.
export function dailyScenarioIndex(d) {
  const date = new Date(d * DAY_MS);
  const rng = mulberry32(hashStr(`aimdle-month-${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`));
  const p = SCENARIOS.map((_, i) => i);
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p[(date.getUTCDate() - 1) % p.length];
}
export function dailyInfo(d = gameDay()) {
  const idx = dailyScenarioIndex(d);
  return { day: d, key: dayKey(d), idx, scene: idx + 1 };
}

