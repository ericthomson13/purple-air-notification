import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-schema.ts"],
    // docs/site has its own vitest.config.js (plain node, no Workers pool -
    // see npm run test:docs) since it's a separate static site with no
    // Worker runtime dependency. Without this, vitest's default file
    // discovery picks up its *.test.js too and runs it twice.
    exclude: ["**/node_modules/**", "docs/site/**"],
  },
});
