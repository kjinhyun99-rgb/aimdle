# aimdle.io

A daily aim-training challenge in the browser. Every day (the day turns over at midnight Pacific time) everyone gets the same scene:
warm up in free play, then play one 60-second ranked run and see where you land on the day's
bell curve. 31 scenes rotate monthly, with no repeats within a month.

One Cloudflare Worker serves both the game and the leaderboard API, backed by a D1 database.
There is no build step: the game is plain HTML and JavaScript modules.

## Project layout

```
public/                 static files served as-is
  index.html            page markup and styles
  js/game.js            the game (three.js r128 from cdnjs, global THREE)
  js/shared/            code used by BOTH the game and the Worker
    util.js             small helpers (random numbers, formatting)
    scenes.js           the 31 scenes, scoring rules, tags
    daily.js            the monthly rotation (which scene is on which day, midnight Pacific)
    validate.js         run validation (anti-cheat), run in the browser and on the server
worker/index.js         leaderboard API (/api/today, /api/scores, /api/runs)
migrations/             D1 database schema
wrangler.jsonc          Cloudflare config (Worker, static files, D1, aimdle.io domain)
```

## First deploy

You need a Cloudflare account that holds the aimdle.io domain, and Node.js 20 or newer.

1. Install the tools (from this folder):
   ```
   npm install
   npx wrangler login
   ```
2. Create the database, then copy the `database_id` it prints into `wrangler.jsonc`
   (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`):
   ```
   npx wrangler d1 create aimdle
   ```
3. Create the tables:
   ```
   npm run db:migrate:remote
   ```
4. Deploy:
   ```
   npm run deploy
   ```
   The `routes` entry in `wrangler.jsonc` attaches the Worker to https://aimdle.io automatically.

### Automatic deploys from GitHub (optional)

In the Cloudflare dashboard, open the `aimdle` Worker's settings and connect this GitHub
repository under **Builds**. Leave the build command empty and set the deploy command to:

```
npx wrangler d1 migrations apply aimdle --remote && npx wrangler deploy
```

After that, every push to `main` deploys, and new database migrations are applied first.

## Running locally

```
npm run db:migrate:local
npm run dev
```

Then open http://localhost:8787. Opening `public/index.html` directly as a file also works,
but without the API: the game runs offline with a simulated field of other players.

## How the leaderboard works

- **Today's scene** comes from the server's clock (`/api/today`), so a wrong computer clock
  can't change it.
- **Ranked runs** are posted to `/api/runs`. The Worker re-runs `validate.js` on every run, so a
  modified client can't post an impossible score. Each player gets one ranked run per day.
- **Players are anonymous**: a random ID stored in the browser. Clearing site data creates a new
  ID, which is accepted as a casual-game trade-off. Each network is limited to 25 ranked runs per
  day (`MAX_RUNS_PER_NETWORK_PER_DAY`), stored as a salted hash, never the raw IP.
- **The bell curve** appears once 20 players have finished the day's scene
  (`MIN_FIELD_FOR_CURVE` in `game.js`). Before that, players see an early-days message.

## Changing scenes

- Scene numbers are positions in `SCENARIOS` (`public/js/shared/scenes.js`). Add new scenes at the
  end so existing numbers don't change.
- Each scene needs an entry in `TAGS` (fixed tag vocabulary) and a `pop: [average, spread]` used
  only by the offline simulated field.
- Changing the number of scenes or their order reshuffles the rotation immediately, including
  the current month, so make those changes on the first day of a month.
