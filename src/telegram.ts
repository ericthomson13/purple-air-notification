import { AQI_HEALTH_INFO_URL, AQI_LEVELS, levelForAqi } from "./aqi";
import type { LocationRow } from "./types";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`Telegram sendMessage failed (${res.status}): ${await res.text()}`);
  }
}

export function formatAlert(location: LocationRow, aqi: number, previousLevelIdx: number, newLevelIdx: number): string {
  const level = AQI_LEVELS[newLevelIdx];
  const direction = newLevelIdx > previousLevelIdx ? "risen into" : "dropped into";
  return (
    `${level.emoji} <b>${location.name}</b> AQI has ${direction} <b>${level.name}</b>\n` +
    `Current AQI: <b>${aqi}</b>\n\n` +
    `What this means for you: ${AQI_HEALTH_INFO_URL}`
  );
}

export function formatStatus(location: LocationRow): string {
  if (location.last_aqi === null || location.last_level === null) {
    return `${location.name}: no reading yet.`;
  }
  const level = levelForAqi(location.last_aqi);
  return `${level.emoji} <b>${location.name}</b>: AQI ${location.last_aqi} (${level.name})\nLast checked: ${location.last_checked_at ?? "unknown"}`;
}

export function formatLocationsList(locations: LocationRow[]): string {
  if (locations.length === 0) return "No locations are registered yet.";
  return (
    "Available locations:\n" +
    locations.map((l) => `- <code>${l.slug}</code> (${l.name})`).join("\n") +
    "\n\nSubscribe with: /subscribe &lt;slug&gt;"
  );
}
