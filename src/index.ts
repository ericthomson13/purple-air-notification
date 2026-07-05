import { levelIndexForAqi } from "./aqi";
import { handleTelegramUpdate } from "./commands";
import { addLocation, listLocations, listSubscriptionsForLocation, updateLocationReading } from "./db";
import { fetchSensorReading } from "./purpleair";
import { formatAlert, sendTelegramMessage, type TelegramUpdate } from "./telegram";
import type { Env } from "./types";

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = (await request.json()) as TelegramUpdate;
  await handleTelegramUpdate(update, env);
  return new Response("ok");
}

async function handleAddLocation(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Forbidden", { status: 403 });
  }
  const body = (await request.json()) as {
    slug: string;
    name: string;
    sensorIndex: number;
    lat?: number;
    lon?: number;
  };
  if (!body.slug || !body.name || !body.sensorIndex) {
    return new Response("slug, name, and sensorIndex are required", { status: 400 });
  }
  await addLocation(env.DB, {
    slug: body.slug,
    name: body.name,
    sensorIndex: body.sensorIndex,
    lat: body.lat ?? null,
    lon: body.lon ?? null,
  });
  return new Response("created", { status: 201 });
}

export async function pollLocations(env: Env): Promise<void> {
  const { results: locations } = await listLocations(env.DB);

  for (const location of locations) {
    try {
      const reading = await fetchSensorReading(location.sensor_index, env.PURPLEAIR_API_KEY);
      const newLevelIdx = levelIndexForAqi(reading.aqi);
      const previousLevelIdx = location.last_level;

      await updateLocationReading(env.DB, location.id, reading.aqi, newLevelIdx);

      if (previousLevelIdx !== null && previousLevelIdx !== newLevelIdx) {
        const { results: subs } = await listSubscriptionsForLocation(env.DB, location.id);
        const text = formatAlert(location, reading.aqi, previousLevelIdx, newLevelIdx);
        await Promise.all(subs.map((sub) => sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, sub.chat_id, text)));
      }
    } catch (err) {
      console.error(`Failed to poll location ${location.slug}:`, err);
    }
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollLocations(env));
  },
};
