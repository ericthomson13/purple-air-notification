import { countryForSlug, handleTelegramUpdate } from "./commands";
import {
  addLocation,
  countAllSubscriptions,
  countDistinctSubscribers,
  countLocations,
  listLocations,
  listLocationSlugs,
  listSubscriptionsForLocation,
  purgeOldReadings,
} from "./db";
import { refreshLocationReading } from "./purpleair";
import { formatAlert, sendTelegramMessage, type TelegramUpdate } from "./telegram";
import type { Env } from "./types";

// Must match wrangler.jsonc's second cron entry exactly - used to tell the
// two scheduled triggers apart in a single scheduled() handler. Exported so
// a test can assert it actually matches wrangler.jsonc, since nothing else
// catches the two silently drifting apart.
export const DAILY_DIGEST_CRON = "0 15 * * 1-5";

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = await parseJsonBody<TelegramUpdate>(request);
  if (!update) {
    return new Response("Invalid JSON body", { status: 400 });
  }
  await handleTelegramUpdate(update, env);
  return new Response("ok");
}

async function handleAddLocation(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Forbidden", { status: 403 });
  }
  const body = await parseJsonBody<{
    slug: string;
    name: string;
    sensorIndex: number;
    lat?: number;
    lon?: number;
  }>(request);
  if (!body?.slug || !body.name || !body.sensorIndex) {
    return new Response("Invalid JSON body - slug, name, and sensorIndex are required", { status: 400 });
  }
  await addLocation(env.DB, {
    slug: body.slug.toLowerCase(), // keep consistent with the self-service /addlocation path
    name: body.name,
    sensorIndex: body.sensorIndex,
    lat: body.lat ?? null,
    lon: body.lon ?? null,
    addedByChatId: null,
  });
  return new Response("created", { status: 201 });
}

export async function pollLocations(env: Env): Promise<void> {
  const { results: locations } = await listLocations(env.DB);

  for (const location of locations) {
    try {
      const previousLevelIdx = location.last_level;
      const { reading, levelIdx: newLevelIdx, past } = await refreshLocationReading(env.DB, location, env.PURPLEAIR_API_KEY);

      if (previousLevelIdx !== null && previousLevelIdx !== newLevelIdx) {
        const { results: subs } = await listSubscriptionsForLocation(env.DB, location.id);
        const text = formatAlert(location, reading.aqi, previousLevelIdx, newLevelIdx, past);
        await Promise.all(subs.map((sub) => sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, sub.chat_id, text)));
      }
    } catch (err) {
      console.error(`Failed to poll location ${location.slug}:`, err);
    }
  }

  try {
    await purgeOldReadings(env.DB);
  } catch (err) {
    console.error("Failed to purge old readings:", err);
  }
}

// Lightweight subscriber-count check-in for the operator, since PurpleAir/
// Cloudflare usage barely scales with user count - this is just for
// tracking growth day to day, not a cost/capacity signal. No-ops if
// ADMIN_CHAT_ID isn't configured.
export async function sendDailySubscriberDigest(env: Env): Promise<void> {
  if (!env.ADMIN_CHAT_ID) return;

  try {
    const [locations, subscriptions, distinctUsers, slugRows] = await Promise.all([
      countLocations(env.DB),
      countAllSubscriptions(env.DB),
      countDistinctSubscribers(env.DB),
      listLocationSlugs(env.DB),
    ]);
    const countries = new Set(slugRows.results.map((row) => countryForSlug(row.slug))).size;

    const text =
      "📊 Daily update\n\n" +
      `users: ${distinctUsers}\n` +
      `subscriptions: ${subscriptions}\n` +
      `locations: ${locations}\n` +
      `countries: ${countries}`;
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, Number(env.ADMIN_CHAT_ID), text);
  } catch (err) {
    console.error("Failed to send daily subscriber digest:", err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/locations") {
      return handleAddLocation(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === DAILY_DIGEST_CRON) {
      ctx.waitUntil(sendDailySubscriberDigest(env));
    } else {
      ctx.waitUntil(pollLocations(env));
    }
  },
};
