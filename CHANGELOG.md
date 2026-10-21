# Changelog

Version numbers: the last number goes up for fixes and small tuning, the middle number for new
scenes, features, or any scoring or difficulty change, and the first number for the public launch
and big changes like accounts or payments.

## 0.2.0 (2026-10-21)

- Feedback box in the menu; messages are saved to the database.
- Privacy page at aimdle.io/privacy.
- Share button on the results screen, and a link preview image for when aimdle.io is posted.
- How-to-play tips on the first visit, reopenable from the menu.
- The HUD font is served from aimdle.io instead of Google Fonts.
- The game version is shown in the menu and saved with each ranked run.

## 0.1.0 (2026-10-21) — first deploy

- 31 scenes in a monthly rotation; the day turns over at midnight Pacific time.
- Free-play warm-up, one 60-second ranked run per day, and a bell curve of the day's scores
  (shown once 20 players have finished).
- Daily leaderboard on Cloudflare Workers and D1, with server-side run checks.
- Void-style rooms with a box-room toggle (B), editable sounds and mute (M), sensitivity
  matching for Valorant, CS2, Apex and Overwatch 2.
