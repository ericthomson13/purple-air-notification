export interface Env {
  DB: D1Database;
  PURPLEAIR_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  // Bot's @username (no @), used to build a shareable https://t.me/<username>
  // link in subscription confirmations. Not a security secret, but kept out
  // of the public repo the same way since it identifies the specific bot.
  TELEGRAM_BOT_USERNAME: string;
  // Optional: the operator's own Telegram chat_id. If set, operational
  // heads-ups (currently: the subscriber safety-net warning) go here
  // instead of to whoever happened to add the location.
  ADMIN_CHAT_ID?: string;
  // Optional: link to the public docs/methodology site (see docs/site/),
  // returned by /documentation. Unset until the operator deploys that site.
  DOCUMENTATION_URL?: string;
}

export interface LocationRow {
  id: number;
  slug: string;
  name: string;
  sensor_index: number;
  lat: number | null;
  lon: number | null;
  last_aqi: number | null;
  last_level: number | null;
  last_checked_at: string | null;
  added_by_chat_id: number | null;
}

export interface SubscriptionRow {
  id: number;
  chat_id: number;
  location_id: number;
  created_at: string;
}

export interface PastReading {
  aqi: number;
  checked_at: string;
}
