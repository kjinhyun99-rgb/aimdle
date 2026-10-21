// aimdle.io Worker: serves the static game (public/) and the daily leaderboard API.
//
//   GET  /api/today              today's scene, from the server's clock (day turns over at midnight Pacific)
//   GET  /api/scores?day=YYYY-MM-DD   that day's ranked scores (for the bell curve)
//   POST /api/runs               submit a ranked run { playerId, run }
//
// Every submitted run is re-validated here with the same code the game uses, so a modified
// client can't post an impossible score. Each anonymous player gets one ranked run per day.
import { gameDay, nextReset, dailyInfo } from '../public/js/shared/daily.js';
import { SCENARIOS } from '../public/js/shared/scenes.js';
import { validateRun } from '../public/js/shared/validate.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RUNS_PER_NETWORK_PER_DAY = 25; // blunts scripted floods of fake player IDs
const MAX_SCORES_RETURNED = 5000;       // larger fields are sampled for the curve
const LATE_GRACE_MS = 3 * 60 * 1000;    // a run that finishes just after midnight Pacific still counts for the day it was played

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAYER_RE = /^[a-f0-9-]{16,64}$/i;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function today() {
  const d = dailyInfo(gameDay());
  return { day: d.key, sceneIndex: d.idx, sceneNumber: d.scene, sceneId: SCENARIOS[d.idx].id, sceneName: SCENARIOS[d.idx].name, nextResetMs: nextReset() };
}

async function getScores(env, url, ctx) {
  // Cache each day's scores at Cloudflare's edge for 20 s, so busy results screens don't each
  // query the database. Requests with a ?t= parameter (a player's own fresh view) skip the cache.
  const cache = typeof caches !== 'undefined' && !url.searchParams.has('t') ? caches.default : null;
  const cacheKey = new Request(url.origin + url.pathname + '?day=' + (url.searchParams.get('day') || ''));
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const res = await buildScores(env, url);
  if (cache && res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function buildScores(env, url) {
  const day = url.searchParams.get('day') || dailyInfo(gameDay()).key;
  if (!DAY_RE.test(day)) return json({ error: 'Use ?day=YYYY-MM-DD.' }, 400);
  const { results } = await env.DB.prepare('SELECT score FROM runs WHERE day = ?1').bind(day).all();
  let scores = results.map((r) => r.score);
  const count = scores.length;
  if (count > MAX_SCORES_RETURNED) {
    // evenly spaced sample of the sorted field keeps the curve's shape and percentiles
    scores.sort((a, b) => a - b);
    const step = count / MAX_SCORES_RETURNED;
    scores = Array.from({ length: MAX_SCORES_RETURNED }, (_, i) => scores[Math.floor(i * step)]);
  }
  return json({ day, count, scores }, 200, { 'cache-control': 'public, max-age=20' });
}

async function postRun(env, request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return json({ ok: false, reason: 'Run data is too large.' }, 413);
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json({ ok: false, reason: 'Run data is not valid JSON.' }, 400); }
  const { playerId, run } = body || {};
  if (typeof playerId !== 'string' || !PLAYER_RE.test(playerId)) return json({ ok: false, reason: 'Missing player ID.' }, 400);
  if (!run || typeof run.dayKey !== 'string' || !DAY_RE.test(run.dayKey)) return json({ ok: false, reason: 'Missing run day.' }, 400);

  // The run must belong to today (Pacific), or to yesterday if it finished in the first minutes after midnight.
  const now = Date.now(), dNow = gameDay(now), dLate = gameDay(now - LATE_GRACE_MS);
  const allowed = [dNow, dLate].map((d) => dailyInfo(d));
  const info = allowed.find((d) => d.key === run.dayKey);
  if (!info) return json({ ok: false, reason: "This run belongs to a different day's challenge." }, 400);
  const scn = SCENARIOS[info.idx];

  const v = validateRun(run, scn, { key: info.key });
  if (!v.ok) return json(v, 400);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = (await sha256Hex(`${info.key}:${ip}`)).slice(0, 32); // salted per day; the raw IP is never stored
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE day = ?1 AND ip_hash = ?2').bind(info.key, ipHash).first();
  if (n >= MAX_RUNS_PER_NETWORK_PER_DAY) return json({ ok: false, reason: 'Too many ranked runs from this network today.' }, 429);

  try {
    await env.DB.prepare('INSERT INTO runs (day, scene_id, player_id, score, stats, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(info.key, scn.id, playerId, run.score, JSON.stringify(run.stats), ipHash, now).run();
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      const prev = await env.DB.prepare('SELECT score FROM runs WHERE day = ?1 AND player_id = ?2').bind(info.key, playerId).first();
      return json({ ok: false, already: true, score: prev ? prev.score : null, reason: 'You already have a ranked score for today.' }, 409);
    }
    throw e;
  }
  const { below, total } = await env.DB.prepare('SELECT SUM(CASE WHEN score < ?2 THEN 1 ELSE 0 END) AS below, COUNT(*) AS total FROM runs WHERE day = ?1').bind(info.key, run.score).first();
  return json({ ok: true, day: info.key, count: total, below });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/today' && request.method === 'GET') return json(today(), 200, { 'cache-control': 'no-store' });
      if (url.pathname === '/api/scores' && request.method === 'GET') return await getScores(env, url, ctx);
      if (url.pathname === '/api/runs' && request.method === 'POST') return await postRun(env, request);
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'Server error. Please try again.' }, 500);
    }
  },
};
