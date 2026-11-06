// Internal errors (acceptance row 21). CONTRACT.md "HTTP API": never a stack trace or internal message.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentHeaders, call, devDeskEnv, gameHeaders, jsonInit, nextIp, TURNSTILE_PASS, type TestEnv } from "./helpers";

const SECRET_DETAIL = "D1_ERROR: no such table: reports_sentinel_7731";

function explode(): never {
  throw new Error(SECRET_DETAIL);
}

// A D1 binding where every entry point fails, as when the database is down.
const brokenDb = {
  prepare: explode,
  batch: async () => explode(),
  exec: async () => explode(),
  dump: async () => explode(),
  withSession: explode,
} as unknown as D1Database;

const routes: [string, string, () => RequestInit, Partial<TestEnv>][] = [
  ["public", "/status/LUM-123456", () => ({ method: "GET" }), {}],
  [
    "public create",
    "/reports",
    () => jsonInit("POST", { what: "The shop does not open.", turnstileToken: TURNSTILE_PASS }, { "CF-Connecting-IP": nextIp() }),
    {},
  ],
  [
    "game",
    "/game/reports",
    () => jsonInit("POST", { userId: 42, userName: "BraveFox", title: "t", what: "w", context: {} }, gameHeaders()),
    {},
  ],
  ["agent", "/agent/queue?limit=5", () => ({ headers: agentHeaders() }), {}],
  ["desk", "/desk/reports", () => ({ method: "GET" }), devDeskEnv],
];

describe("internal errors", () => {
  it.each(routes)("row 21: a failing database on the %s route %s answers 500 {\"error\":\"internal\"} only", async (_area, path, init, envOverride) => {
    const res = await call(path, init(), { ...envOverride, DB: brokenDb });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('{"error":"internal"}');
    expect(text).not.toContain("at ");
    expect(text).not.toContain("Error");
    expect(text).not.toContain(SECRET_DETAIL);
    expect(res.headers.get("Content-Type") ?? "").toContain("application/json");
  });

  it("row 21 (edge): the status lookup answers normally with the real database, so the 500 above comes from the failure", async () => {
    const res = await call("/status/LUM-123456", { method: "GET" }, { DB: env.DB });
    expect(res.status).toBe(404);
  });
});
