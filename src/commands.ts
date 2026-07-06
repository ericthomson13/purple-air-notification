import { AQI_CORRECTION_NOTE, AQI_LEVELS, dangerZoneNote, levelIndexForAqi } from "./aqi";
import {
  addLocation,
  addSubscription,
  countLocations,
  countSubscriptionsForLocation,
  deleteLocation,
  getLocationBySlug,
  getPastReading,
  insertReadingHistory,
  listLocations,
  listSubscriptionsForChat,
  listSubscriptionsForLocation,
  removeSubscription,
  updateLocationReading,
} from "./db";
import { geocodeCityState } from "./geocode";
import { fetchSensorReading, findNearestSensor, getFreshReading, SensorDivergenceError, TREND_LOOKBACK_MINUTES } from "./purpleair";
import { formatLocationsList, formatPastNote, formatStatus, sendTelegramMessage, type TelegramUpdate } from "./telegram";
import type { Env, LocationRow } from "./types";

// Requested locations must be a lowercase, hyphenated "city-state" slug,
// e.g. boulder-co, salt-lake-city-ut.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$/;

// Caps total PurpleAir calls from the scheduled poll, which fetches every
// registered location every 10 min regardless of subscriber count - the
// thing that actually scales with self-service location adding.
const MAX_LOCATIONS = 50;

// Cloudflare Workers' free-tier limit is 50 external subrequests per
// invocation - every alert send is one, and a threshold crossing fans out
// to all of a location's subscribers in a single invocation. Warn early
// (40) and again at the actual wall (50) so growth doesn't silently start
// dropping notifications.
const SUBSCRIBER_WARNING_THRESHOLD = 40;
const SUBSCRIBER_HARD_CAP = 50;

const ADD_LOCATION_USAGE =
  "Usage: /addlocation &lt;slug&gt;\n" +
  "Example: /addlocation boulder-co\n\n" +
  "The slug must be lowercase, hyphenated, and end in the 2-letter state code, e.g. boulder-co or salt-lake-city-ut - " +
  "the bot reads the city and state from it, finds it on the map, and picks the nearest active PurpleAir sensor automatically.\n\n" +
  "If that doesn't find anything, you can specify a sensor yourself instead: /addlocation &lt;slug&gt; &lt;sensor_index&gt; &lt;City, ST&gt; " +
  "(find sensor_index at https://map.purpleair.com - click a sensor and check the page URL, e.g. ?select=242389).";

const WELCOME =
  "Welcome to the PurpleAir AQI notifier.\n\n" +
  "Commands:\n" +
  "/locations - list available locations\n" +
  "/subscribe &lt;slug&gt; - get alerts for a location\n" +
  "/addlocation &lt;slug&gt; - add a new location (e.g. boulder-co) and subscribe to it\n" +
  "/removelocation &lt;slug&gt; - remove a location you added (only the adder can)\n" +
  "/unsubscribe &lt;slug&gt; - stop alerts for a location\n" +
  "/status - show your subscriptions and their current AQI\n" +
  "/documentation - link to how this bot works and why its AQI numbers may differ from PurpleAir's map\n\n" +
  `AQI values are ${AQI_CORRECTION_NOTE} (using the EPA/PurpleAir correction for known PM2.5 overestimation) - they may read lower than PurpleAir's own map, which shows raw, uncorrected values by default.`;

// "salt-lake-city-ut" -> { city: "Salt Lake City", state: "UT" }. Only ever
// called on slugs that already passed SLUG_PATTERN.
function parseSlug(slug: string): { city: string; state: string } {
  const parts = slug.split("-");
  const state = parts[parts.length - 1].toUpperCase();
  const city = parts
    .slice(0, -1)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
  return { city, state };
}

// Since PurpleAir/Cloudflare usage barely moves with more users (see
// SUBSCRIBER_HARD_CAP for the one real per-location limit), it's cheap to
// encourage sharing - included on subscription-confirmation messages.
function shareLine(env: Env): string {
  // TELEGRAM_BOT_USERNAME is meant to be a bare username, but it's easy to
  // accidentally paste the full https://t.me/<username> link from Telegram's
  // UI when configuring the secret - strip that back down so we don't end
  // up with a doubled-up link like https://t.me/https://t.me/foo.
  const username = env.TELEGRAM_BOT_USERNAME.replace(/^(https?:\/\/)?t\.me\//i, "").replace(/^@/, "");
  return `\n\nKnow someone else who'd find this useful? Share the bot: https://t.me/${username}`;
}

// Warns when a location's subscriber count crosses the point where
// Cloudflare's free-tier subrequest limit risks silently dropping alert
// sends. Goes to ADMIN_CHAT_ID (the operator) if configured - that's who
// can actually act on it (e.g. upgrade to Workers Paid) - falling back to
// whoever added the location if no admin chat is set up.
async function checkSubscriberSafetyNet(env: Env, location: LocationRow): Promise<void> {
  const count = await countSubscriptionsForLocation(env.DB, location.id);
  if (count !== SUBSCRIBER_WARNING_THRESHOLD && count !== SUBSCRIBER_HARD_CAP) return;

  const text =
    count >= SUBSCRIBER_HARD_CAP
      ? `${location.name} (${location.slug}) has reached ${count} subscribers — Cloudflare's free-tier limit is ~50 alert sends per threshold crossing for one location. Subscribers beyond this may silently stop getting notified. Upgrading to Workers Paid ($5/mo) removes this cap.`
      : `${location.name} (${location.slug}) just crossed ${count} subscribers — heads up, Cloudflare's free tier caps alert fan-out at ~50 recipients per threshold crossing for one location. Worth planning ahead if this keeps growing.`;

  console.warn(text);

  const recipient = env.ADMIN_CHAT_ID ? Number(env.ADMIN_CHAT_ID) : location.added_by_chat_id;
  if (recipient !== null) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, recipient, text);
  }
}

// Subscribes chatId to location and returns a line describing the current
// AQI (using a cached reading if it's fresh - see getFreshReading). Shared
// by /subscribe and /addlocation's "location already exists" path.
async function subscribeAndDescribeAqi(env: Env, chatId: number, location: LocationRow): Promise<string> {
  await addSubscription(env.DB, chatId, location.id);
  await checkSubscriberSafetyNet(env, location);
  try {
    const { aqi, levelIdx, past, swappedTo } = await getFreshReading(env.DB, location, env.PURPLEAIR_API_KEY);
    const level = AQI_LEVELS[levelIdx];
    const swapNote = swappedTo
      ? ` (Note: ${location.name}'s old PurpleAir sensor was reporting inconsistent data, so we've switched it to a nearby one: "${swappedTo.name}".)`
      : "";
    return `Current AQI for ${location.name} is ${aqi} ${level.emoji} ${level.name}${formatPastNote(past)}.${dangerZoneNote(aqi)} (${AQI_CORRECTION_NOTE})${swapNote}`;
  } catch (err) {
    console.error(`Failed to fetch current reading for ${location.slug}:`, err);
    if (err instanceof SensorDivergenceError) {
      return `Current AQI for ${location.name} isn't available — its PurpleAir sensor is reporting inconsistent data and no healthy sensor was found nearby to switch to. Reach out to whoever runs this bot to get it updated.`;
    }
    return `Current AQI for ${location.name} isn't available right now — you'll get it on the next scheduled check.`;
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const [command, ...args] = message.text.trim().split(/\s+/);

  switch (command) {
    case "/start": {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
      break;
    }

    case "/locations": {
      const { results } = await listLocations(env.DB);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatLocationsList(results));
      break;
    }

    case "/subscribe": {
      const slug = args[0]?.toLowerCase();
      if (!slug) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /subscribe &lt;slug&gt; (see /locations)");
        break;
      }
      const location = await getLocationBySlug(env.DB, slug);
      if (!location) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Unknown location "${slug}". See /locations, or /addlocation to add it.`);
        break;
      }
      const aqiLine = await subscribeAndDescribeAqi(env, chatId, location);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `Thanks for signing up to our AQI bot leveraging PurpleAir data. ${aqiLine}\n\nYou'll be notified when it crosses 50/100/150/200/300.${shareLine(env)}`,
      );
      break;
    }

    case "/addlocation": {
      const [slugRaw, ...rest] = args;
      const slug = slugRaw?.toLowerCase();

      if (!slug) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, ADD_LOCATION_USAGE);
        break;
      }

      if (!SLUG_PATTERN.test(slug)) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `"${slug}" doesn't look like city-state format. Use lowercase and hyphens, ending in the 2-letter state code, e.g. boulder-co or salt-lake-city-ut.`,
        );
        break;
      }

      const existing = await getLocationBySlug(env.DB, slug);
      if (existing) {
        const aqiLine = await subscribeAndDescribeAqi(env, chatId, existing);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `${existing.name} is already tracked as "${slug}" — subscribing you now. ${aqiLine}${shareLine(env)}`);
        break;
      }

      const locationCount = await countLocations(env.DB);
      if (locationCount >= MAX_LOCATIONS) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `We're at our location limit (${MAX_LOCATIONS}) for now to keep PurpleAir API usage in check. Reach out to whoever runs this bot to request a new one.`,
        );
        break;
      }

      let sensorIndex: number;
      let name: string;
      let discoveredSensorName: string | null = null;

      if (rest.length === 0) {
        // Easy path: just the slug. Derive the place from it, geocode, and
        // auto-pick the nearest active PurpleAir sensor.
        const { city, state } = parseSlug(slug);
        name = `${city}, ${state}`;

        let place;
        try {
          place = await geocodeCityState(city, state);
        } catch (err) {
          console.error(`Failed to geocode "${name}" for ${slug}:`, err);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `Couldn't look up "${name}" right now — try again in a moment, or specify a sensor yourself: /addlocation ${slug} &lt;sensor_index&gt; ${name}`,
          );
          break;
        }
        if (!place) {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `Couldn't find "${name}" — double check the spelling in the slug, or specify a sensor yourself: /addlocation ${slug} &lt;sensor_index&gt; ${name}`,
          );
          break;
        }

        let nearest;
        try {
          nearest = await findNearestSensor(place.lat, place.lon, env.PURPLEAIR_API_KEY);
        } catch (err) {
          console.error(`Failed to search PurpleAir sensors near "${name}":`, err);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `Found ${name} but couldn't search PurpleAir for sensors nearby — try again, or specify one yourself: /addlocation ${slug} &lt;sensor_index&gt; ${name}`,
          );
          break;
        }
        if (!nearest) {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `Found ${name} but no active PurpleAir sensors nearby. Find one yourself at https://map.purpleair.com and use: /addlocation ${slug} &lt;sensor_index&gt; ${name}`,
          );
          break;
        }

        sensorIndex = nearest.sensorIndex;
        discoveredSensorName = nearest.name;
      } else {
        // Fallback path: /addlocation <slug> <sensor_index> <City, ST>
        const [sensorIndexRaw, ...nameParts] = rest;
        name = nameParts.join(" ");
        sensorIndex = Number(sensorIndexRaw);

        if (!Number.isInteger(sensorIndex) || sensorIndex <= 0 || !name) {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, ADD_LOCATION_USAGE);
          break;
        }
      }

      let reading;
      try {
        reading = await fetchSensorReading(sensorIndex, env.PURPLEAIR_API_KEY);
      } catch (err) {
        console.error(`Failed to validate sensor ${sensorIndex} for new location ${slug}:`, err);
        const message =
          err instanceof SensorDivergenceError
            ? `sensor_index ${sensorIndex}'s two PM2.5 channels disagree too much to trust — it may be malfunctioning. Pick a different sensor at https://map.purpleair.com and try again.`
            : `Couldn't read sensor_index ${sensorIndex} from PurpleAir — it may be offline. Double check at https://map.purpleair.com and try again.`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message);
        break;
      }

      try {
        await addLocation(env.DB, { slug, name, sensorIndex, lat: null, lon: null, addedByChatId: chatId });
      } catch (err) {
        console.error(`Failed to insert location ${slug}:`, err);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `That location may have just been added by someone else — try /subscribe ${slug}.`);
        break;
      }

      const newLocation = await getLocationBySlug(env.DB, slug);
      if (!newLocation) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Something went wrong adding that location — please try again.");
        break;
      }

      const levelIdx = levelIndexForAqi(reading.aqi);
      await updateLocationReading(env.DB, newLocation.id, reading.aqi, levelIdx);
      await insertReadingHistory(env.DB, newLocation.id, reading.aqi, levelIdx);
      await addSubscription(env.DB, chatId, newLocation.id);

      const level = AQI_LEVELS[levelIdx];
      const sensorNote = discoveredSensorName ? ` (using PurpleAir sensor "${discoveredSensorName}")` : "";
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `Added ${newLocation.name} (${slug})${sensorNote} and subscribed you. Current AQI is ${reading.aqi} ${level.emoji} ${level.name}.${dangerZoneNote(reading.aqi)} (${AQI_CORRECTION_NOTE})\n\nYou'll be notified when it crosses 50/100/150/200/300.${shareLine(env)}`,
      );
      break;
    }

    case "/removelocation": {
      const slug = args[0]?.toLowerCase();
      if (!slug) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /removelocation &lt;slug&gt; — only the chat that added a location can remove it.");
        break;
      }
      const location = await getLocationBySlug(env.DB, slug);
      if (!location) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Unknown location "${slug}".`);
        break;
      }
      if (location.added_by_chat_id !== chatId) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `Only whoever added "${slug}" can remove it${location.added_by_chat_id === null ? " (it was registered by the bot operator)" : ""}. If you just want to stop your own alerts, use /unsubscribe ${slug} instead.`,
        );
        break;
      }

      const { results: subscribers } = await listSubscriptionsForLocation(env.DB, location.id);
      await deleteLocation(env.DB, location.id);

      const otherSubscribers = subscribers.filter((s) => s.chat_id !== chatId).length;
      const impactNote = otherSubscribers > 0 ? ` Note: ${otherSubscribers} other subscriber(s) will no longer get alerts for it.` : "";
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Removed ${location.name} (${slug}).${impactNote}`);
      break;
    }

    case "/unsubscribe": {
      const slug = args[0]?.toLowerCase();
      if (!slug) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /unsubscribe &lt;slug&gt;");
        break;
      }
      const location = await getLocationBySlug(env.DB, slug);
      if (!location) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Unknown location "${slug}".`);
        break;
      }
      await removeSubscription(env.DB, chatId, location.id);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Unsubscribed from ${location.name}.`);
      break;
    }

    case "/status": {
      const { results: subs } = await listSubscriptionsForChat(env.DB, chatId);
      if (subs.length === 0) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "You aren't subscribed to any locations yet. See /locations.");
        break;
      }
      const statuses = await Promise.all(
        subs.map(async (sub) => {
          const location = await getLocationBySlug(env.DB, sub.slug);
          if (!location) return `${sub.name}: not found`;

          // Refresh (or self-heal, via getFreshReading's divergence handling)
          // before reading back location.last_aqi below - otherwise /status
          // would just echo whatever bogus value a diverging sensor last
          // wrote to D1 instead of catching it.
          let swapNote = "";
          try {
            const { swappedTo } = await getFreshReading(env.DB, location, env.PURPLEAIR_API_KEY);
            if (swappedTo) {
              swapNote = ` (switched to a nearby sensor: "${swappedTo.name}" after the old one reported inconsistent data)`;
            }
          } catch (err) {
            console.error(`Failed to refresh reading for ${location.slug} during /status:`, err);
            if (err instanceof SensorDivergenceError) {
              return `${location.name}: its PurpleAir sensor is reporting inconsistent data and no healthy sensor was found nearby. Reach out to whoever runs this bot to get it updated.`;
            }
            // Transient API failure, not a data-quality problem - fall back to whatever's cached.
          }

          const fresh = (await getLocationBySlug(env.DB, location.slug)) ?? location;
          const past = await getPastReading(env.DB, fresh.id, TREND_LOOKBACK_MINUTES);
          return formatStatus(fresh, past, swapNote);
        }),
      );
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, statuses.join("\n\n"));
      break;
    }

    case "/documentation": {
      const text = env.DOCUMENTATION_URL
        ? `How this bot works, and why its AQI numbers are EPA-corrected: ${env.DOCUMENTATION_URL}`
        : "No documentation link is configured for this bot yet.";
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
      break;
    }

    default: {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
    }
  }
}
