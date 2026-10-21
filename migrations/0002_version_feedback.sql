-- Which game version each ranked run was played on.
ALTER TABLE runs ADD COLUMN version TEXT;

-- Messages sent from the in-game feedback box.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,          -- ms since epoch
  category    TEXT    NOT NULL,          -- bug | scene | idea | other
  message     TEXT    NOT NULL,
  scene_id    TEXT,                      -- scene on screen when the message was sent
  version     TEXT,                      -- game version
  browser     TEXT,                      -- short browser/OS description
  player_id   TEXT,
  ip_hash     TEXT    NOT NULL           -- SHA-256 of day + IP (raw IPs are never stored)
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
CREATE INDEX IF NOT EXISTS feedback_ip_day ON feedback (ip_hash, created_at);
