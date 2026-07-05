# purple-air-notification

Get a Telegram message when the air quality (AQI) at a location crosses a
significant threshold — 50, 100, 150, 200, or 300 — in either direction.
Data comes from [PurpleAir](https://www2.purpleair.com/) community sensors.
Ships with one location out of the box: **Leadville, CO** — but anyone can
add and subscribe to additional locations (or a single location that isn't
Leadville) straight from the bot, and subscribe to more than one at a time.
See [Adding a location](#7-add-a-location) below.

Just want to subscribe rather than run this yourself? See
[docs/user-guide.md](./docs/user-guide.md) for a non-technical signup walkthrough.

## How it works

- A [Cloudflare Worker](https://developers.cloudflare.com/workers/) runs on a
  [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  every 10 minutes. It fetches the latest PM2.5 reading for each registered
  location from the PurpleAir API, applies the [EPA/Barkjohn correction](https://amt.copernicus.org/articles/14/4617/2021/)
  (raw PurpleAir PM2.5 reads high, especially in smoke, and needs correcting
  before it's a real AQI), and converts it to AQI using the
  [2024-revised EPA breakpoints](https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf).
- The result is compared against the location's last known AQI category. If
  the category changed (crossed 50/100/150/200/300 going up or down), every
  Telegram chat subscribed to that location gets a message like:
  *"AQI has dropped below 100 — now 92 (was 150 ~32m ago)."* The "was X ~Nm
  ago" context comes from a small `readings_history` log (one row per
  location per poll), which is purged of anything older than a day — we
  only need recent history for that comparison, not a long-term archive.
- Subscription is entirely self-service through the Telegram bot — DM it,
  run `/subscribe leadville-co`, done. No website, no account to create.
  `/subscribe` also fetches a fresh reading on the spot and replies with the
  current AQI immediately, so you get instant confirmation the bot is
  actually working instead of waiting for the next scheduled poll. A chat
  can be subscribed to any number of locations at once — there's no
  one-location-per-user limit.
- Anyone can add a new location themselves with `/addlocation`, no admin
  required — see [Adding a location](#7-add-a-location). To keep PurpleAir
  API usage bounded (the scheduled poll fetches *every* registered location
  every 10 minutes, forever, regardless of how many people subscribe to
  each one), total locations are capped at 50 (`MAX_LOCATIONS` in
  `src/commands.ts`).
- Whenever a reported AQI is 100 or higher, replies include a direct link
  to what that level means health-wise, not just in threshold-crossing alerts.
- State (locations + subscriptions + recent reading history) lives in
  [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite).

### Why this stack

| Concern | Choice | Why |
|---|---|---|
| Polling | Cloudflare Workers Cron Trigger | 1-minute minimum granularity (well under our 15-30 min need), free tier covers this workload by several orders of magnitude, and it's fully serverless — no VPS to keep alive. GitHub Actions cron was considered and rejected: its scheduled triggers are routinely delayed 10-60+ minutes under load, which defeats near-real-time alerting. |
| Storage | Cloudflare D1 | Free tier: 5M row reads/day, 100k row writes/day, 5GB storage. This project uses a few hundred reads/writes a day at most — effectively free forever unless it scales to hundreds of locations. |
| Notifications | Telegram Bot API | Free, no phone number/SMS costs, and the bot itself doubles as the entire signup UI (webhook-based, not polling — appropriate for a serverless Worker that should stay asleep between requests). |

## Alert levels

| AQI range | Level | Color | What it means |
|---|---|---|---|
| 0–50 | 🟢 Good | `#00e400` | [Air quality is satisfactory](https://www.airnow.gov/aqi/aqi-basics/) |
| 51–100 | 🟡 Moderate | `#ffff00` | [Acceptable; unusually sensitive people should consider limiting prolonged outdoor exertion](https://www.airnow.gov/aqi/aqi-basics/) |
| 101–150 | 🟠 Unhealthy for Sensitive Groups | `#ff7e00` | [Sensitive groups may experience health effects](https://www.airnow.gov/aqi/aqi-basics/) |
| 151–200 | 🔴 Unhealthy | `#ff0000` | [Everyone may begin to experience health effects](https://www.airnow.gov/aqi/aqi-basics/) |
| 201–300 | 🟣 Very Unhealthy | `#8f3f97` | [Health alert: everyone may experience more serious health effects](https://www.airnow.gov/aqi/aqi-basics/) |
| 301+ | 🟤 Hazardous | `#7e0023` | [Health warning of emergency conditions](https://www.airnow.gov/aqi/aqi-basics/) |

These map almost exactly onto the [2024-revised EPA PM2.5 AQI breakpoints](https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf).

## Setup

You'll end up setting five secrets on the Worker (plus one optional one).
Only two of them actually come from an external service — the rest you
generate or fill in yourself:

| Env var | Where it comes from |
|---|---|
| `PURPLEAIR_API_KEY` | PurpleAir — see [step 2](#2-get-a-purpleair-api-read-key) |
| `TELEGRAM_BOT_TOKEN` | BotFather — the token it gives you after `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET` | **You generate this** (e.g. `openssl rand -hex 24`) — verifies incoming webhook requests really came from Telegram |
| `ADMIN_TOKEN` | **You generate this** too — protects the `/admin/locations` endpoint |
| `TELEGRAM_BOT_USERNAME` | Your bot's `@username` (no `@`) from BotFather/its Telegram profile — not a secret in the security sense, but kept out of the public repo since it identifies the specific bot. Used to build the shareable `t.me/<username>` link in subscription confirmations |
| `ADMIN_CHAT_ID` *(optional)* | Your own Telegram chat_id — message [@userinfobot](https://t.me/userinfobot) to get it. If set, you get DM'd when any location crosses 40 or 50 subscribers (see "Why this stack" below); if unset, that warning goes to whoever added the location instead |

### 1. Prerequisites

- Node.js 18+ and npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is enough)
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) — installed as a dev dependency, no global install needed

```bash
git clone https://github.com/ericthomson13/purple-air-notification.git
cd purple-air-notification
npm install
npx wrangler login
```

### 2. Get a PurpleAir API read key

PurpleAir's API isn't self-serve signup yet — email **contact@purpleair.com**
requesting a **read key** for the public API (mention you're building a
non-commercial air quality notifier). Details: https://api.purpleair.com/ and
https://community.purpleair.com/t/about-the-purpleair-api/7145

You'll get back a key that looks like a UUID. That's `PURPLEAIR_API_KEY` below.

### 3. Create a Telegram bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
2. BotFather gives you a token like `123456789:AAExampleTokenValue` — that's `TELEGRAM_BOT_TOKEN`. It also shows you the bot's `@username` you just picked — that's `TELEGRAM_BOT_USERNAME` (no `@`).
3. Generate `TELEGRAM_WEBHOOK_SECRET` and `ADMIN_TOKEN` yourself (see the table above) — BotFather has nothing to do with these two.
4. Optional: message [@userinfobot](https://t.me/userinfobot) to get your own numeric chat_id for `ADMIN_CHAT_ID`.

### 4. Create the D1 database and apply the schema

```bash
npx wrangler d1 create purple-air-notification
# copy the returned database_id into wrangler.jsonc (d1_databases[0].database_id)

npm run db:migrate:remote
```

### 5. Set secrets and deploy

Copy `.env.example` to `.env` and fill in the four values from the table
above. `.env` is gitignored — it never gets committed or leaves your
machine. Run this in your own terminal (not through an AI assistant or
shared session):

```bash
cp .env.example .env
# edit .env with real values

npm run deploy
```

`npm run deploy` runs `scripts/sync-secrets.sh` first, which checks each
required secret against what's already set on your Worker (via
`wrangler secret list`) and pushes any that are missing, straight from
`.env` — so you never have to run `wrangler secret put` by hand unless you
want to. Secrets that are already set on Cloudflare are left alone (the
script can't read their values back, only their names, so it won't
overwrite something you set another way). If a required secret is missing
both on Cloudflare and in `.env`, `deploy` stops before touching the Worker
and tells you which ones to fill in.

To sync secrets without deploying: `npm run secrets:sync`.

Note the `*.workers.dev` URL wrangler prints (or your custom domain).

### 6. Point Telegram's webhook at your Worker

Add `WORKER_URL` (the `*.workers.dev` URL from step 5) to your `.env`, then:

```bash
npm run webhook:set      # registers the webhook with Telegram
npm run webhook:status   # confirms Telegram sees it - "url" should match WORKER_URL
```

Both read `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `WORKER_URL`
from `.env`, so there's nothing to copy-paste by hand. If you'd rather do it
manually:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 7. Add a location

The easy path — just the slug, no technical steps required. DM the bot:

```
/addlocation boulder-co
```

- `slug` must be lowercase, hyphenated, and end in the 2-letter state code —
  e.g. `boulder-co`, `salt-lake-city-ut`. This is enforced (`SLUG_PATTERN` in
  `src/commands.ts`); a malformed slug gets rejected with an example.
- The bot parses "Boulder, CO" out of the slug itself, geocodes it via
  [OpenStreetMap Nominatim](https://nominatim.org/) (free, no API key — see
  `src/geocode.ts`; its usage policy caps casual use at ~1 req/sec and
  requires a descriptive User-Agent, both fine for this on-demand,
  one-request-per-`/addlocation` pattern), then queries PurpleAir for
  active sensors in a ~10-mile box around that point and picks the closest
  one (`findNearestSensor` in `src/purpleair.ts`).
- If the slug already exists, `/addlocation` just subscribes you to it
  instead of erroring.
- Total locations are capped at 50 (see "Why this stack" above) — once hit,
  new `/addlocation` calls are rejected until an existing one is removed.

Registering and subscribing happen in one step, and you get the current AQI
back immediately as confirmation, along with the name of the sensor it
picked so you can sanity-check it (e.g. against
[map.purpleair.com](https://map.purpleair.com/)).

**Fallback: specify a sensor yourself.** If geocoding or sensor search comes
up empty (rural area, name the geocoder doesn't recognize, etc.), find a
`sensor_index` manually — go to [map.purpleair.com](https://map.purpleair.com/),
zoom to the area, click a sensor that looks well-placed (outdoors, not next
to an obvious pollution source), and read its **Sensor Index** from the
popup or page URL (`?select=<sensor_index>`). Then:

```
/addlocation boulder-co 242389 Boulder, CO
```

`sensor_index` is validated by fetching it from PurpleAir before the
location is created — a bad number fails immediately rather than silently
registering a dead sensor.

**Alternative: the HTTP admin endpoint.** Still available if you'd rather
register locations out-of-band (e.g. scripting several at once) without
going through a Telegram chat — this path skips both geocoding and the
sensor-liveness check, so use a `sensor_index` you've already verified:

```bash
curl -X POST "https://<your-worker>.workers.dev/admin/locations" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "leadville-co",
    "name": "Leadville, CO",
    "sensorIndex": <SENSOR_INDEX_FROM_THE_MAP>,
    "lat": 39.2508,
    "lon": -106.2925
  }'
```

This doesn't validate the sensor or auto-subscribe anyone — it's a raw
insert. Leadville, CO ships as the reference example; you'll need to
register a real `sensorIndex` for it (or any other town) using either path
above, since sensor IDs can change as sensors go offline or get replaced.

### 8. Try it

DM your bot:

```
/start
/locations
/subscribe leadville-co
/status
```

`/subscribe` immediately replies with something like:

> Thanks for signing up to our AQI bot leveraging PurpleAir data. Current
> AQI for Leadville, CO is 42 (🟢 Good).
>
> You'll be notified when it crosses 50/100/150/200/300.

That's your confirmation the whole pipeline — PurpleAir key, sensor,
Worker, D1, Telegram — is wired up correctly. After that, you'll get a
message automatically whenever that location's AQI crosses 50, 100, 150,
200, or 300 in either direction.

To try adding a second, non-Leadville location and confirm you can be
subscribed to more than one at once:

```
/addlocation boulder-co
/status
```

`/status` should now show both Leadville and Boulder (or whichever
locations you've subscribed to) in one reply.

## Local development

```bash
npm run db:migrate:local
npm run dev              # wrangler dev, local D1 + local Worker
npm run typecheck
```

Local dev won't receive real Telegram webhooks unless you tunnel it (e.g.
`cloudflared tunnel`) and point `setWebhook` at the tunnel URL temporarily.

Note: `wrangler dev` reads local secrets from `.dev.vars` (Wrangler's own
convention), not `.env`. `.env` is only consumed by `scripts/sync-secrets.sh`
to push real secrets to your deployed Worker. If you want the same values
available locally, copy them into a `.dev.vars` file too (also gitignored).

## Versioning & deploy notifications

The project uses plain [semver](https://semver.org/) via npm's built-in
`npm version` — no extra tooling. To cut a new version:

```bash
npm version patch   # or minor / major
git push --follow-tags
npm run deploy
```

`npm version` bumps `package.json`, commits that change, and creates a git
tag (`v0.1.1`, etc.) in one step; `--follow-tags` pushes the tag along with
the commit.

If `ADMIN_CHAT_ID` is set, `npm run deploy` automatically DMs you
`✅ purple-air-notification deployed successfully — version X.X.X` once the
deploy succeeds (wired as the `postdeploy` npm lifecycle hook — see
`scripts/notify-deploy.sh`). A failed deploy never reaches this step. If
`ADMIN_CHAT_ID` isn't set, it's silently skipped.

## Project structure

```
src/
  index.ts      Worker entry point: HTTP routes + scheduled() cron handler
  purpleair.ts  PurpleAir API fetch + EPA correction + AQI calculation
  aqi.ts        AQI breakpoints, alert levels, colors
  telegram.ts   Telegram API calls + message formatting
  commands.ts   Telegram bot command handling (/start, /subscribe, etc.)
  db.ts         D1 query helpers
scripts/
  sync-secrets.sh    Pushes missing secrets from .env to Cloudflare before deploy
  set-webhook.sh     Registers the Worker's URL with Telegram's setWebhook API
  webhook-status.sh  Prints Telegram's current webhook registration (getWebhookInfo)
  notify-deploy.sh   DMs ADMIN_CHAT_ID with the deployed version (postdeploy hook)
schema.sql      D1 table definitions (locations, subscriptions, readings_history)
wrangler.jsonc  Worker + cron trigger + D1 binding config
.env.example    Template for secrets + WORKER_URL (copy to .env, gitignored)
```

## Roadmap

- [x] Single hardcoded reference location (Leadville, CO) with threshold alerts
- [x] Self-service subscribe/unsubscribe via Telegram bot commands
- [x] Self-service `/addlocation` — any user can register a new city-state
      location and subscribe to any number of locations at once, no admin
      step required. Capped at 50 total locations to bound PurpleAir API usage.
- [x] `/addlocation <slug>` alone (e.g. `/addlocation boulder-co`) geocodes
      the place from the slug and auto-discovers the nearest active
      PurpleAir sensor — no `sensor_index` lookup needed for the common
      case. Manually specifying a `sensor_index` is now just the fallback
      for when geocoding/sensor search comes up empty.
- [ ] Per-user configurable thresholds (not everyone wants alerts at all five levels)
- [ ] Multi-sensor averaging per location (reduce reliance on a single sensor going offline/miscalibrated)
- [ ] Web dashboard for browsing historical AQI per location

## License

MIT — see [LICENSE](./LICENSE).
