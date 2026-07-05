import { AQI_HEALTH_INFO_URL, AQI_LEVELS, dangerZoneNote, levelForAqi } from "./aqi";
import type { LocationRow, PastReading } from "./types";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

// checked_at is a SQLite `datetime('now')` string (UTC, no timezone suffix).
function minutesAgo(checkedAt: string): number {
  const past = new Date(`${checkedAt}Z`).getTime();
  return Math.max(1, Math.round((Date.now() - past) / 60_000));
}

export function formatPastNote(past: PastReading | null | undefined): string {
  return past ? ` (was ${past.aqi} ~${minutesAgo(past.checked_at)}m ago)` : "";
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

export function formatAlert(
  location: LocationRow,
  aqi: number,
  previousLevelIdx: number,
  newLevelIdx: number,
  past?: PastReading | null,
): string {
  const level = AQI_LEVELS[newLevelIdx];
  const rising = newLevelIdx > previousLevelIdx;
  const direction = rising ? "risen above" : "dropped below";
  // The crossed boundary is always the threshold of whichever level is lower.
  const crossedThreshold = AQI_LEVELS[Math.min(previousLevelIdx, newLevelIdx)].threshold;

  return (
    `${level.emoji} <b>${location.name}</b> AQI has ${direction} <b>${crossedThreshold}</b> — now <b>${aqi}</b>${formatPastNote(past)}\n` +
    `Category: <b>${level.name}</b>\n\n` +
    `What this means for you: ${AQI_HEALTH_INFO_URL}`
  );
}

export function formatStatus(location: LocationRow, past?: PastReading | null, swapNote?: string): string {
  if (location.last_aqi === null || location.last_level === null) {
    return `${location.name}: no reading yet.`;
  }
  const level = levelForAqi(location.last_aqi);
  return `${level.emoji} <b>${location.name}</b>: AQI ${location.last_aqi}${formatPastNote(past)} (${level.name})${swapNote ?? ""}\nLast checked: ${location.last_checked_at ?? "unknown"}${dangerZoneNote(location.last_aqi)}`;
}

export function formatLocationsList(locations: LocationRow[]): string {
  if (locations.length === 0) return "No locations are registered yet.";
  return (
    "Available locations:\n" +
    locations.map((l) => `- <code>${l.slug}</code> (${l.name})`).join("\n") +
    "\n\nSubscribe with: /subscribe &lt;slug&gt;"
  );
}
