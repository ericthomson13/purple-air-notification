export interface Env {
  DB: D1Database;
  PURPLEAIR_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
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
}

export interface SubscriptionRow {
  id: number;
  chat_id: number;
  location_id: number;
  created_at: string;
}
