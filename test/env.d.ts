declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PURPLEAIR_API_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    ADMIN_TOKEN: string;
    TELEGRAM_BOT_USERNAME: string;
    ADMIN_CHAT_ID?: string;
  }
}
