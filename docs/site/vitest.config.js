import { defineConfig } from "vitest/config";

// Deliberately separate from the root vitest.config.ts (which wires up the
// Cloudflare Workers test pool for the bot itself) - this static site has no
// Worker runtime dependency at all, just plain browser JS, so it runs under
// vitest's default (node) environment instead.
export default defineConfig({
  test: {
    include: ["*.test.js"],
  },
});
