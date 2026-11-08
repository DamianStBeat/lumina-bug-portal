// CONTRACT.md "Worker bindings and secrets", last paragraph: var `TURNSTILE_VERIFY_URL` replaces Cloudflare's siteverify
// URL only when `ENVIRONMENT` is `dev` (the end-to-end run answers it locally); with any other `ENVIRONMENT` it is
// ignored. The production cases protect real players: a stray var must not be able to move the check off Cloudflare.
//
// Each spec sets the two answers apart (Cloudflare says one thing, the local URL the other), so the result proves who
// answered as well as the URL list does. An empty var counts as no var: the contract does not say it, this spec binds
// the builder (a dev config with `"TURNSTILE_VERIFY_URL": ""` must not break the form).
//
// Run by filter: `cd worker && npx vitest run test/turnstile-dev.spec.ts`.
//
// Mutations (file|old|new|label), proved on a throwaway prototype of the builder's code (done-4t-tests.md):
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" && env.TURNSTILE_VERIFY_URL ?|env.TURNSTILE_VERIFY_URL ?|var honoured in every environment
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" &&|env.ENVIRONMENT !== "production" &&|anything but production
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" &&|env.ENVIRONMENT?.toLowerCase() === "dev" &&|case folded
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" &&|env.ENVIRONMENT?.trim() === "dev" &&|trimmed
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" &&|env.ENVIRONMENT?.startsWith("dev") &&|prefix
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" && env.TURNSTILE_VERIFY_URL ? env.TURNSTILE_VERIFY_URL : SITEVERIFY|env.ENVIRONMENT === "dev" ? env.TURNSTILE_VERIFY_URL! : SITEVERIFY|no fallback without the var
// worker/src/lib/turnstile.ts|env.ENVIRONMENT === "dev" && env.TURNSTILE_VERIFY_URL ? env.TURNSTILE_VERIFY_URL : SITEVERIFY|env.ENVIRONMENT === "dev" ? (env.TURNSTILE_VERIFY_URL ?? SITEVERIFY) : SITEVERIFY|empty var taken as a URL
// worker/src/lib/turnstile.ts|await fetch(url,|await fetch(SITEVERIFY,|var ignored in dev
// worker/src/lib/turnstile.ts|{ method: "POST", body: form }|url === SITEVERIFY ? { method: "POST", body: form } : { method: "POST" }|local call without secret and token
// worker/src/lib/turnstile.ts|return res.ok &&|return url !== SITEVERIFY \|\| res.ok &&|local answer ignored
// worker/src/routes/public.ts|await verifyTurnstile(env,|await verifyTurnstile({ ...env, ENVIRONMENT: "dev" },|route forces dev
// worker/src/routes/public.ts|await verifyTurnstile(env,|await verifyTurnstile({ ...env, ENVIRONMENT: "production" },|route forces production
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/lib/turnstile";
import { body, call, jsonInit, nextIp, outbound, TURNSTILE_PASS, uniqueText } from "./helpers";

const CLOUDFLARE = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const LOCAL = "http://127.0.0.1:8799/turnstile/siteverify";
const IP = "203.0.113.7";

type Seen = { url: string; method: string; body: string };

// Replaces the fake of setup.ts for one spec: every siteverify call is recorded, whatever host it goes to.
function stubSiteverify(answers: { cloudflare: boolean; local: boolean }): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, method: req.method, body: await req.text() });
    return Response.json({ success: req.url === CLOUDFLARE ? answers.cloudflare : answers.local });
  });
  return seen;
}

// The worker's real bindings with these two set, or absent when null: "unset" must be a missing key, not a value.
function envWith(environment: string | null, verifyUrl: string | null): Env {
  const e: Partial<Env> & { TURNSTILE_VERIFY_URL?: string } = { ...env };
  delete e.ENVIRONMENT;
  delete e.TURNSTILE_VERIFY_URL;
  if (environment !== null) e.ENVIRONMENT = environment;
  if (verifyUrl !== null) e.TURNSTILE_VERIFY_URL = verifyUrl;
  return e as Env;
}

const urls = (seen: Seen[]) => seen.map((s) => s.url);

describe("the siteverify URL: local only in dev", () => {
  it("dev with the var: the var's URL, and only that one", async () => {
    const seen = stubSiteverify({ cloudflare: false, local: true });
    expect(await verifyTurnstile(envWith("dev", LOCAL), TURNSTILE_PASS, IP)).toBe(true);
    expect(urls(seen)).toEqual([LOCAL]);
  });

  it("dev with the var: only the URL changes, the local call carries the same check", async () => {
    const seen = stubSiteverify({ cloudflare: false, local: true });
    await verifyTurnstile(envWith("dev", LOCAL), TURNSTILE_PASS, IP);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toContain(env.TURNSTILE_SECRET);
    expect(seen[0]?.body).toContain(TURNSTILE_PASS);
    expect(seen[0]?.body).toContain(IP);
  });

  it("dev with the var: a local no is a no, the gate does not open because the URL is local", async () => {
    const seen = stubSiteverify({ cloudflare: true, local: false });
    expect(await verifyTurnstile(envWith("dev", LOCAL), TURNSTILE_PASS, IP)).toBe(false);
    expect(urls(seen)).toEqual([LOCAL]);
  });

  it("dev without the var: Cloudflare's URL", async () => {
    const seen = stubSiteverify({ cloudflare: true, local: false });
    expect(await verifyTurnstile(envWith("dev", null), TURNSTILE_PASS, IP)).toBe(true);
    expect(urls(seen)).toEqual([CLOUDFLARE]);
  });

  it("dev with an empty var: no var, Cloudflare's URL", async () => {
    const seen = stubSiteverify({ cloudflare: true, local: false });
    expect(await verifyTurnstile(envWith("dev", ""), TURNSTILE_PASS, IP)).toBe(true);
    expect(urls(seen)).toEqual([CLOUDFLARE]);
  });

  it("production with the var: Cloudflare's URL, the var cannot move the check", async () => {
    const seen = stubSiteverify({ cloudflare: false, local: true });
    expect(await verifyTurnstile(envWith("production", LOCAL), TURNSTILE_PASS, IP)).toBe(false);
    expect(urls(seen)).toEqual([CLOUDFLARE]);
  });

  it("ENVIRONMENT unset with the var: Cloudflare's URL (not knowing is not dev)", async () => {
    const seen = stubSiteverify({ cloudflare: false, local: true });
    expect(await verifyTurnstile(envWith(null, LOCAL), TURNSTILE_PASS, IP)).toBe(false);
    expect(urls(seen)).toEqual([CLOUDFLARE]);
  });

  // Past the edge of the one value that opens it: only the exact word `dev` does.
  it.each(["Dev", "DEV", "dev ", " dev", "development", "staging", "test", ""])(
    "ENVIRONMENT %j with the var: Cloudflare's URL",
    async (environment) => {
      const seen = stubSiteverify({ cloudflare: false, local: true });
      expect(await verifyTurnstile(envWith(environment, LOCAL), TURNSTILE_PASS, IP)).toBe(false);
      expect(urls(seen)).toEqual([CLOUDFLARE]);
    },
  );
});

describe("the siteverify URL through the real route", () => {
  const submit = (over: { ENVIRONMENT: string; TURNSTILE_VERIFY_URL: string }) =>
    call(
      "/reports",
      jsonInit("POST", { what: uniqueText("A report behind the check"), turnstileToken: TURNSTILE_PASS }, { "CF-Connecting-IP": nextIp() }),
      over,
    );

  it("production with the var: POST /reports is checked by Cloudflare", async () => {
    // setup.ts's fake answers only Cloudflare's host: a call to the var's URL would be refused and fail the spec.
    const res = await submit({ ENVIRONMENT: "production", TURNSTILE_VERIFY_URL: LOCAL });
    expect(res.status, JSON.stringify(await body(res.clone()))).toBe(201);
    expect(outbound.turnstileCalls).toBe(1);
  });

  it("dev with the var: POST /reports is checked by the var's URL", async () => {
    const seen = stubSiteverify({ cloudflare: false, local: true });
    const res = await submit({ ENVIRONMENT: "dev", TURNSTILE_VERIFY_URL: LOCAL });
    expect(res.status, JSON.stringify(await body(res.clone()))).toBe(201);
    expect(urls(seen)).toEqual([LOCAL]);
  });
});
