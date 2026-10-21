// Run validation. The game runs this before submitting, and the Worker runs the exact same
// code on every submission, so a tampered client can't post an impossible score.
import { DPS, SCORE } from './scenes.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export function validateRun(run, scn, today) {
  const fail = (reason) => ({ ok: false, reason });
  if (!run || run.v !== 1) return fail('Unknown run format.');
  if (run.dayKey !== today.key) return fail("This run belongs to a different day's challenge.");
  if (run.scenarioId !== scn.id) return fail("This run isn't today's scenario.");
  const s = run.stats;
  if (!s || typeof s !== 'object') return fail('Missing run stats.');
  for (const k of ['kills', 'clickShots', 'clickHits', 'trackFire', 'trackOn', 'damage', 'sphereKills', 'botKills', 'activeMs']) if (!isNum(s[k])) return fail('Run stats are malformed.');
  if (!isNum(run.score)) return fail('Score is malformed.');
  if (!Array.isArray(s.killTimes) || s.killTimes.length > 1000 || !s.killTimes.every(isNum)) return fail('Kill log is malformed.');
  if (![s.kills, s.clickShots, s.clickHits, s.sphereKills, s.botKills].every(Number.isInteger)) return fail('Run stats are malformed.');
  const sec = s.activeMs / 1000;
  if (!(s.activeMs >= 59900 && s.activeMs <= 60400)) return fail('Run length is not 60 seconds.');
  if (s.clickHits > s.clickShots || s.sphereKills > s.clickHits) return fail('Hit counts are inconsistent.');
  if (s.clickShots / sec > 25) return fail('Click rate is not humanly possible.');
  if (s.trackOn > s.trackFire + 1e-6 || s.trackFire > sec + 0.3) return fail('Tracking time is inconsistent.');
  if (Math.abs(s.damage - s.trackOn * DPS) > 1 + s.damage * 0.002) return fail('Damage does not match time on target.');
  if (s.kills !== s.sphereKills + s.botKills || s.killTimes.length !== s.kills) return fail('Kill log does not match kill count.');
  for (let i = 1; i < s.killTimes.length; i++) {
    if (s.killTimes[i] < s.killTimes[i - 1]) return fail('Kill log is out of order.');
    if (scn.kind === 'click' && s.killTimes[i] - s.killTimes[i - 1] < 30) return fail('Kills are closer together than a human can click.');
  }
  const score = SCORE[scn.score](s);
  if (Math.abs(score - run.score) > (scn.decimals ? 0.051 : 0.51)) return fail('Reported score does not match the run.');
  if (score > scn.max) return fail('Score is above the maximum possible for this scenario.');
  return { ok: true };
}

