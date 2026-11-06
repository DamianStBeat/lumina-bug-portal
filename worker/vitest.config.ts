import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test values only. ENVIRONMENT stays "production" so every spec exercises the real auth path unless it overrides env.
const migrations = await readD1Migrations("./migrations").catch((err: unknown) => {
  // Before the builder adds migrations/ the specs must still load and fail on the missing worker, not on the config.
  if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
  throw err;
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "https://bugs.lumina.test,https://preview.lumina.test",
          ENVIRONMENT: "production",
          ACCESS_TEAM_DOMAIN: "lumina-test.cloudflareaccess.com",
          ACCESS_AUD: "test-access-aud-0001",
          TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
          GAME_KEY: "test-game-key-not-a-secret",
          AGENT_KEY: "test-agent-key-not-a-secret",
          IP_SALT_SEED: "test-ip-salt-seed",
          DESK_DEV_BYPASS: "0",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 60_000,
  },
});
