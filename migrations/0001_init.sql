-- One row per ranked run. A player (anonymous browser ID) gets one ranked run per UTC day.
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT    NOT NULL,          -- UTC date, YYYY-MM-DD
  scene_id    TEXT    NOT NULL,          -- e.g. '6-bubbles'
  player_id   TEXT    NOT NULL,          -- random ID stored in the player's browser
  score       REAL    NOT NULL,
  stats       TEXT    NOT NULL,          -- JSON run stats, kept for later review
  ip_hash     TEXT    NOT NULL,          -- SHA-256 of day + IP (raw IPs are never stored)
  created_at  INTEGER NOT NULL           -- ms since epoch
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_day_player ON runs (day, player_id);
CREATE INDEX IF NOT EXISTS runs_day_score ON runs (day, score);
CREATE INDEX IF NOT EXISTS runs_day_ip ON runs (day, ip_hash);
