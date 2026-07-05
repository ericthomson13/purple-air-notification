# purple-air-notification

Get a Telegram message when the air quality (AQI) at a location crosses a
significant threshold — 50, 100, 150, 200, or 300 — in either direction.
Data comes from [PurpleAir](https://www2.purpleair.com/) community sensors.
Ships with one location out of the box: **Leadville, CO**.

## How it works

- A [Cloudflare Worker](https://developers.cloudflare.com/workers/) runs on a
  [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  every 15 minutes. It fetches the latest PM2.5 reading for each registered
  location from the PurpleAir API, applies the [EPA/Barkjohn correction](https://amt.copernicus.org/articles/14/4617/2021/)
  (raw PurpleAir PM2.5 reads high, especially in smoke, and needs correcting
  before it's a real AQI), and converts it to AQI using the
  [2024-revised EPA breakpoints](https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf).
- The result is compared against the location's last known AQI category. If
  the category changed (crossed 50/100/150/200/300 going up or down), every
  Telegram chat subscribed to that location gets a message.
- Subscription is entirely self-service through the Telegram bot — DM it,
  run `/subscribe leadville-co`, done. No website, no account to create.
  `/subscribe` also fetches a fresh reading on the spot and replies with the
  current AQI immediately, so you get instant confirmation the bot is
  actually working instead of waiting for the next scheduled poll.
- State (locations + subscriptions) lives in [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite).

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

You'll end up setting four secrets on the Worker. Only one of them actually
comes from an external service — the other three you generate yourself:

| Env var | Where it comes from |
|---|---|
| `PURPLEAIR_API_KEY` | PurpleAir — see [step 2](#2-get-a-purpleair-api-read-key) |
| `TELEGRAM_BOT_TOKEN` | BotFather — the token it gives you after `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET` | **You generate this** (e.g. `openssl rand -hex 24`) — verifies incoming webhook requests really came from Telegram |
| `ADMIN_TOKEN` | **You generate this** too — protects the `/admin/locations` endpoint |

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
2. BotFather gives you a token like `123456789:AAExampleTokenValue`. That's your only externally-issued secret — `TELEGRAM_BOT_TOKEN`.
3. Generate `TELEGRAM_WEBHOOK_SECRET` and `ADMIN_TOKEN` yourself (see the table above) — BotFather has nothing to do with these two.

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

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 7. Add a location

PurpleAir doesn't offer a search-by-city-name API, so finding a sensor is a
manual, one-time step per location. Two ways to do it:

**Option A — the map (visual, easiest for one-off lookups).** Go to
[map.purpleair.com](https://map.purpleair.com/), zoom to the town/area you
care about, and click a sensor that looks well-placed (outdoors, not next to
an obvious pollution source like a wood stove chimney or a garage). Its
**Sensor Index** is in the popup / the page URL (`?select=<sensor_index>`).

**Option B — the API (scriptable, useful if you're adding several locations).**
Query sensors inside a bounding box around your target lat/lon:

```bash
curl -s "https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,last_seen&nwlat=<NW_LAT>&nwlng=<NW_LNG>&selat=<SE_LAT>&selng=<SE_LNG>" \
  -H "X-API-Key: <PURPLEAIR_API_KEY>" | python3 -m json.tool
```

The response has a `fields` array and a `data` array of rows — the first
value in each row is always the `sensor_index`. Pick one with a recent
`last_seen` timestamp.

Either way, once you have a `sensor_index`, register it:

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

Leadville, CO ships as the reference example — you'll need to fill in a real
`sensorIndex` for it (or any other town) using the steps above, since sensor
IDs can change as sensors go offline or get replaced.

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
  sync-secrets.sh  Pushes missing secrets from .env to Cloudflare before deploy
schema.sql      D1 table definitions (locations, subscriptions)
wrangler.jsonc  Worker + cron trigger + D1 binding config
.env.example    Template for the four secrets (copy to .env, gitignored)
```

## Roadmap

- [x] Single hardcoded reference location (Leadville, CO) with threshold alerts
- [x] Self-service subscribe/unsubscribe via Telegram bot commands
- [ ] Let a user type a place name (`/subscribe "Boulder, CO"`) and have the
      bot geocode it and auto-discover the nearest PurpleAir sensor, instead
      of requiring an admin to register locations by hand
- [ ] Per-user configurable thresholds (not everyone wants alerts at all five levels)
- [ ] Multi-sensor averaging per location (reduce reliance on a single sensor going offline/miscalibrated)
- [ ] Web dashboard for browsing historical AQI per location

## License

MIT — see [LICENSE](./LICENSE).
