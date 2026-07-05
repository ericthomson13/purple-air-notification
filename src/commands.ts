import { AQI_LEVELS } from "./aqi";
import {
  addSubscription,
  getLocationBySlug,
  listLocations,
  listSubscriptionsForChat,
  removeSubscription,
} from "./db";
import { refreshLocationReading } from "./purpleair";
import { formatLocationsList, formatStatus, sendTelegramMessage, type TelegramUpdate } from "./telegram";
import type { Env } from "./types";

const WELCOME =
  "Welcome to the PurpleAir AQI notifier.\n\n" +
  "Commands:\n" +
  "/locations - list available locations\n" +
  "/subscribe &lt;slug&gt; - get alerts for a location\n" +
  "/unsubscribe &lt;slug&gt; - stop alerts for a location\n" +
  "/status - show your subscriptions and their current AQI";

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
      const slug = args[0];
      if (!slug) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /subscribe &lt;slug&gt; (see /locations)");
        break;
      }
      const location = await getLocationBySlug(env.DB, slug);
      if (!location) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Unknown location "${slug}". See /locations.`);
        break;
      }
      await addSubscription(env.DB, chatId, location.id);

      let aqiLine: string;
      try {
        const { reading, levelIdx } = await refreshLocationReading(env.DB, location, env.PURPLEAIR_API_KEY);
        const level = AQI_LEVELS[levelIdx];
        aqiLine = `Current AQI for ${location.name} is ${reading.aqi} (${level.emoji} ${level.name}).`;
      } catch (err) {
        console.error(`Failed to fetch current reading for ${location.slug}:`, err);
        aqiLine = `Current AQI for ${location.name} isn't available right now — you'll get it on the next scheduled check.`;
      }

      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `Thanks for signing up to our AQI bot leveraging PurpleAir data. ${aqiLine}\n\nYou'll be notified when it crosses 50/100/150/200/300.`,
      );
      break;
    }

    case "/unsubscribe": {
      const slug = args[0];
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
          return location ? formatStatus(location) : `${sub.name}: not found`;
        }),
      );
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, statuses.join("\n\n"));
      break;
    }

    default: {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
    }
  }
}
