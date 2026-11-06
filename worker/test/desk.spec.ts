// Desk API (acceptance rows 17-18). CONTRACT.md "HTTP API" > Desk: Cloudflare Access JWT (RS256, JWKS at
// https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs, aud = ACCESS_AUD, exp), dev bypass only with ENVIRONMENT=dev.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, devDeskEnv, expectError, outbound, pattern, seedAttachment, seedReport } from "./helpers";

const KID = "desk-spec-key-1";
let signingKey: CryptoKey;
let strangerKey: CryptoKey;

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(payload: Record<string, unknown>, key: CryptoKey = signingKey, kid = KID): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const claims = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [env.ACCESS_AUD],
    email: "tester@lumina.test",
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
    sub: "desk-spec-user",
    type: "app",
    ...over,
  };
}

function deskGet(path: string, headers: Record<string, string> = {}, envOverride = {}): Promise<Response> {
  return call(`/desk${path}`, { headers }, envOverride);
}

beforeAll(async () => {
  // One key for the whole file: a worker may cache the JWKS, so the served key never changes between tests.
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const stranger = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  strangerKey = stranger.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  outbound.jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" } as JsonWebKey] };
});

describe("desk auth", () => {
  it("row 17: no JWT in production gives 401, even with DESK_DEV_BYPASS=1", async () => {
    await expectError(await deskGet("/reports"), 401);
    await expectError(await deskGet("/reports", {}, { ENVIRONMENT: "production", DESK_DEV_BYPASS: "1" }), 401);
  });

  it("row 17: ENVIRONMENT=dev with DESK_DEV_BYPASS=1 and no JWT gives 200", async () => {
    const res = await deskGet("/reports", {}, devDeskEnv);
    expect(res.status).toBe(200);
  });

  it.each([
    ["ENVIRONMENT=dev without the bypass", { ENVIRONMENT: "dev", DESK_DEV_BYPASS: "0" }],
    ["ENVIRONMENT=dev with the bypass unset", { ENVIRONMENT: "dev", DESK_DEV_BYPASS: undefined }],
    ["ENVIRONMENT=staging with the bypass", { ENVIRONMENT: "staging", DESK_DEV_BYPASS: "1" }],
  ])("row 17 (edge): %s and no JWT gives 401", async (_label, envOverride) => {
    await expectError(await deskGet("/reports", {}, envOverride), 401);
  });

  it("row 17: a valid Access JWT (right aud, future exp, signed by the JWKS key) gives 200 in production", async () => {
    const token = await signJwt(claims());
    const res = await deskGet("/reports", { "Cf-Access-Jwt-Assertion": token });
    expect(res.status).toBe(200);
  });

  it("row 17: a JWT for another audience gives 401", async () => {
    const token = await signJwt(claims({ aud: ["some-other-application"] }));
    await expectError(await deskGet("/reports", { "Cf-Access-Jwt-Assertion": token }), 401);
  });

  it("row 17: an expired JWT gives 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(claims({ exp: now - 60, iat: now - 700, nbf: now - 700 }));
    await expectError(await deskGet("/reports", { "Cf-Access-Jwt-Assertion": token }), 401);
  });

  it.each([
    ["signed by a key the JWKS does not hold", async () => signJwt(claims(), strangerKey)],
    ["not a JWT at all", async () => "abc.def.ghi"],
    ["with alg none and no signature", async () => `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify(claims()))}.`],
  ])("contract: a token %s gives 401", async (_label, make) => {
    await expectError(await deskGet("/reports", { "Cf-Access-Jwt-Assertion": await make() }), 401);
  });
});

describe("GET /desk/attachments/{id}/stream", () => {
  async function seedVideo(): Promise<{ id: string; bytes: Uint8Array }> {
    const r = await seedReport();
    const bytes = pattern(18, 0, 1000);
    const a = await seedAttachment(r.id, { size_bytes: bytes.length, status: "complete", completed_at: Date.now() });
    await env.FILES.put(a.r2_key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    return { id: a.id, bytes };
  }

  it("row 18: Range bytes=0-99 on a complete video answers 206 with the first 100 bytes", async () => {
    const v = await seedVideo();
    const res = await deskGet(`/attachments/${v.id}/stream`, { Range: "bytes=0-99" }, devDeskEnv);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(100);
    expect([...got]).toEqual([...v.bytes.slice(0, 100)]);
  });

  it("row 18 (edge): Range bytes=100-199 answers the second hundred bytes", async () => {
    const v = await seedVideo();
    const res = await deskGet(`/attachments/${v.id}/stream`, { Range: "bytes=100-199" }, devDeskEnv);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...v.bytes.slice(100, 200)]);
  });

  it("row 18 (edge): without Range the whole object comes back with 200", async () => {
    const v = await seedVideo();
    const res = await deskGet(`/attachments/${v.id}/stream`, {}, devDeskEnv);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...v.bytes]);
  });

  it("row 18 (edge): the stream needs desk auth like every desk route", async () => {
    const v = await seedVideo();
    await expectError(await deskGet(`/attachments/${v.id}/stream`, { Range: "bytes=0-99" }), 401);
  });
});
