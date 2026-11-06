// Game API (acceptance rows 11-12). CONTRACT.md "HTTP API" > Game.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  body,
  call,
  CODE_RE,
  eventTypesOf,
  expectError,
  gameHeaders,
  jsonInit,
  reportByCode,
  reportsWithWhatLike,
  uniqueText,
} from "./helpers";

// The keys CONTRACT.md lists for `context`; anything else must be dropped.
const CONTEXT_KEYS = [
  "placeId",
  "placeVersion",
  "jobId",
  "map",
  "mode",
  "wave",
  "device",
  "platform",
  "fps",
  "pingMs",
  "errors",
  "at",
];

let nextUserId = 7_000_000 + Math.floor(Math.random() * 1_000_000);

function gameReport(context: Record<string, unknown>, what = uniqueText("Wave timer stops")) {
  nextUserId += 1;
  return { userId: nextUserId, userName: "BraveFox", title: "Wave 12 freezes", what, lang: "en", context };
}

function postGame(payload: unknown, headers: Record<string, string> = gameHeaders()): Promise<Response> {
  return call("/game/reports", jsonInit("POST", payload, headers));
}

describe("POST /game/reports", () => {
  it("row 11: right key, unknown context keys dropped, 80 error lines cut to 50", async () => {
    const errors = Array.from({ length: 80 }, (_, i) => `ServerScriptService.Waves:${i + 1}: attempt to index nil`);
    const payload = gameReport({
      placeId: 123,
      placeVersion: 45,
      jobId: "job-abc",
      map: "Forest",
      mode: "normal",
      wave: 12,
      device: "phone",
      platform: "iOS",
      fps: 58,
      pingMs: 120,
      errors,
      at: 1_762_400_000_000,
      adminOverride: true,
      sessionTicket: "should-not-be-stored",
      nested: { deep: 1 },
    });

    const res = await postGame(payload);

    expect(res.status).toBe(201);
    const { code } = await body<{ code: string }>(res);
    expect(code).toMatch(CODE_RE);
    const row = await reportByCode(code);
    expect(row!.source).toBe("game");
    expect(row!.status).toBe("received");
    expect(row!.roblox_user_id).toBe(payload.userId);
    expect(row!.title).toBe("Wave 12 freezes");
    expect(row!.what).toBe(payload.what);
    expect(await eventTypesOf(row!.id)).toEqual(["created"]);

    const ctx = JSON.parse(row!.game_context!) as Record<string, unknown>;
    for (const key of Object.keys(ctx)) expect(CONTEXT_KEYS, `stored context key ${key}`).toContain(key);
    expect(ctx).not.toHaveProperty("adminOverride");
    expect(ctx).not.toHaveProperty("sessionTicket");
    expect(ctx).not.toHaveProperty("nested");
    expect(ctx.map).toBe("Forest");
    expect(ctx.wave).toBe(12);
    expect(ctx.placeId).toBe(123);
    expect(ctx.device).toBe("phone");
    const stored = ctx.errors as string[];
    expect(stored).toHaveLength(50);
    expect(new Set(stored).size).toBe(50);
    for (const e of stored) expect(errors).toContain(e);
  });

  it("row 11 (edge): exactly 50 error lines are all kept", async () => {
    const errors = Array.from({ length: 50 }, (_, i) => `error line ${i + 1}`);
    const res = await postGame(gameReport({ errors }));
    expect(res.status).toBe(201);
    const row = await reportByCode((await body<{ code: string }>(res)).code);
    const ctx = JSON.parse(row!.game_context!) as { errors: string[] };
    expect([...ctx.errors].sort()).toEqual([...errors].sort());
  });

  it("row 11 (edge): an error line over 300 characters is not stored at full length", async () => {
    const res = await postGame(gameReport({ errors: ["short one", "E".repeat(400)] }));
    expect(res.status).toBe(201);
    const row = await reportByCode((await body<{ code: string }>(res)).code);
    const ctx = JSON.parse(row!.game_context!) as { errors: string[] };
    for (const e of ctx.errors) expect(e.length).toBeLessThanOrEqual(300);
    expect(ctx.errors).toContain("short one");
  });

  it.each([
    ["a wrong key of the same length", (key: string) => ({ "X-Game-Key": "x".repeat(key.length) })],
    ["the right key minus its last character", (key: string) => ({ "X-Game-Key": key.slice(0, -1) })],
    ["no key", (_key: string): Record<string, string> => ({})],
  ])("row 12: %s gives 401 and stores nothing", async (_label, headersFor) => {
    const what = uniqueText("row12");
    await expectError(await postGame(gameReport({ map: "Forest" }, what), headersFor(env.GAME_KEY)), 401);
    expect(await reportsWithWhatLike(what)).toBe(0);
  });
});
