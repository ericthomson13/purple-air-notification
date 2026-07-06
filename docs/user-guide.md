# Get air quality alerts for your area

Get a message the moment the air quality changes enough to matter for your
health — no app to install besides Telegram (which you may already have),
no account to create, completely free. Leadville, CO is set up out of the
box, and you can add your own town too (see below) — you're not limited to
just one location either.

## Step 1: Get Telegram

Telegram is a free messaging app, similar to WhatsApp or iMessage. If you
already have it, skip to Step 2.

- **Phone:** search "Telegram" in the App Store (iPhone) or Google Play (Android)
- **Computer:** [telegram.org](https://telegram.org/), or use it right in your browser at [web.telegram.org](https://web.telegram.org/) with no download at all

Setup takes about a minute: open the app, enter your phone number, enter the
code it texts you.

## Step 2: Open the bot

**[ Bot link goes here — use the one you were sent directly. If you don't
have it, ask whoever pointed you to this guide. ]**

## Step 3: Say hello

Tap the link, then tap **Start** (or type `/start` and send it). The bot
will reply with a short list of what it can do.

## Step 4: Subscribe

Send this message to the bot, exactly as written:

```
/subscribe leadville-co
```

You'll get an immediate reply with the current air quality for Leadville —
that's your confirmation everything worked.

## What you'll get after that

You'll automatically get a message whenever the air quality crosses one of
five levels, in either direction — so you're told both when it gets worse
and when it's safe again. For example:

> 🟡 Leadville, CO AQI has dropped below 100 — now 92 (was 150 about 30 minutes ago)
> Category: Moderate

## What the levels mean

| | Level | What it means |
|---|---|---|
| 🟢 | Good | Air quality is fine for everyone. |
| 🟡 | Moderate | Fine for most people. If you have asthma or another breathing condition, take it a bit easier outside. |
| 🟠 | Unhealthy for Sensitive Groups | Kids, older adults, and anyone with heart or lung conditions should limit time outdoors. |
| 🔴 | Unhealthy | Everyone may start to notice effects (irritated eyes/throat, shortness of breath). Limit outdoor activity. |
| 🟣 | Very Unhealthy | Health alert — avoid outdoor activity if you can. |
| 🟤 | Hazardous | Emergency conditions — stay indoors. |

More detail on any level: [airnow.gov/aqi/aqi-basics](https://www.airnow.gov/aqi/aqi-basics/)

## Want alerts for a different town (or more than one)?

You're not limited to Leadville, and you're not limited to just one place —
subscribe to as many locations as you want. Just send the bot something like:

```
/addlocation boulder-co
```

The slug needs to be lowercase with hyphens, ending in the 2-letter state
code — like `boulder-co` or `salt-lake-city-ut`. The bot figures out the
town from that, finds the nearest air quality sensor on its own, checks
it's real and currently reporting, then subscribes you and replies with the
current AQI — same as the confirmation you got when you first subscribed.
It'll also tell you which sensor it picked, so you can double-check it on
[map.purpleair.com](https://map.purpleair.com/) if you want. If someone
already added that location, this just subscribes you to it instead of
creating a duplicate.

**If it can't find anything** (small town, unusual name), it'll tell you,
and you can point it at a specific sensor instead:

1. Go to [map.purpleair.com](https://map.purpleair.com/), zoom to the town,
   and click a sensor that looks reasonably placed (outdoors, not right next
   to something like a wood stove or a garage).
2. Look at the page's URL — it'll contain something like `?select=242389`.
   That number is the **sensor index**.
3. Send: `/addlocation boulder-co 242389 Boulder, CO`

## Managing your alerts

Send any of these to the bot any time:

- `/status` — check the current reading for everywhere you're subscribed
- `/unsubscribe leadville-co` — stop getting alerts for a location
- `/locations` — see what locations are already available
- `/documentation` — link to how this bot works and why its AQI numbers may
  read differently than PurpleAir's own map

## Privacy

The bot stores only your Telegram ID and which location(s) you've
subscribed to — no name, phone number, or other personal information.
Unsubscribe any time and it stops messaging you immediately.

## Questions or problems?

Reach out to whoever shared this guide with you.
