// Bindings of the worker (wrangler.jsonc, secrets) plus TEST_MIGRATIONS, which only the test pool provides.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    ALLOWED_ORIGINS: string;
    ENVIRONMENT: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    TURNSTILE_SECRET: string;
    GAME_KEY: string;
    AGENT_KEY: string;
    IP_SALT_SEED: string;
    DESK_DEV_BYPASS?: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
type Env = Cloudflare.Env;
