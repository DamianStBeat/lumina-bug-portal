import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { fakeFetch, outbound } from "./outbound";

beforeAll(async () => {
  // Idempotent: applied migrations are recorded in d1_migrations.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  outbound.unexpected = [];
  outbound.turnstileCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(outbound.unexpected, "the worker called a host no spec stubs").toEqual([]);
});
