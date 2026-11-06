// Cloudflare Access in front of the desk (CONTRACT.md "HTTP API" > Desk). Access already blocks strangers at the
// edge; this check makes the worker refuse a request that reached it some other way (workers.dev, a missing Access
// rule), so the desk never depends on one configuration screen alone.
import { HttpError } from "./http";

/** Who passed Access: the email claim when the token carries one (service tokens do not). */
export type DeskIdentity = { email: string | null };

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
// Access rotates its keys every few weeks and keeps the old one published for a while, so minutes are safe.
const JWKS_TTL_MS = 5 * 60_000;
// An unknown kid forces a refresh at most this often: forged tokens with random kids cannot make us hammer Access.
const JWKS_REFRESH_MIN_MS = 60_000;

let jwks: { domain: string; at: number; keys: Map<string, CryptoKey> } | null = null;

const unauthorized = () => new HttpError(401, "unauthorized");

function base64urlBytes(part: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw unauthorized();
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unauthorized();
  return parsed as Record<string, unknown>;
}

async function fetchKeys(domain: string, now: number): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw unauthorized();
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const k of Array.isArray(body.keys) ? body.keys : []) {
    const jwk = k as Record<string, unknown>;
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    try {
      // Only the modulus and exponent: a stray `alg`/`key_ops` in the published key must not change how it is used.
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, RSA, false, ["verify"]));
    } catch {
      // One malformed key in the set does not hide the others.
    }
  }
  jwks = { domain, at: now, keys };
  return keys;
}

async function keyFor(domain: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  const cached = jwks && jwks.domain === domain ? jwks : null;
  if (cached && now - cached.at < JWKS_TTL_MS && (cached.keys.has(kid) || now - cached.at < JWKS_REFRESH_MIN_MS)) {
    return cached.keys.get(kid);
  }
  return (await fetchKeys(domain, now)).get(kid);
}

async function verifyAccessJwt(env: Env, token: string): Promise<DeskIdentity> {
  const domain = env.ACCESS_TEAM_DOMAIN ?? "";
  const aud = env.ACCESS_AUD ?? "";
  // Empty settings lock the desk instead of accepting any audience or fetching keys from a bare "https:///".
  if (!domain || !aud) throw unauthorized();
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  const [head, body, sig] = parts as [string, string, string];

  // Exactly RS256: `none`, HS256 (the public key used as an HMAC secret) and every other alg are refused.
  const header = jsonObject(base64urlBytes(head));
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") throw unauthorized();

  const now = Date.now();
  const key = await keyFor(domain, header.kid, now);
  if (!key) throw unauthorized();
  const signed = new TextEncoder().encode(`${head}.${body}`);
  if (!(await crypto.subtle.verify(RSA, key, base64urlBytes(sig), signed))) throw unauthorized();

  // Claims are read only after the signature holds: before that they are anybody's words.
  const claims = jsonObject(base64urlBytes(body));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) throw unauthorized();
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) throw unauthorized();
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds)) throw unauthorized();
  if (claims.iss !== undefined && claims.iss !== `https://${domain}`) throw unauthorized();
  return { email: typeof claims.email === "string" ? claims.email : null };
}

/**
 * 401 `unauthorized` unless the request carries a valid Access JWT in `Cf-Access-Jwt-Assertion`. The bypass needs
 * both exact values, so a production worker with a leftover DESK_DEV_BYPASS=1 still checks every token.
 */
export async function requireDeskAccess(env: Env, req: Request): Promise<DeskIdentity> {
  if (env.ENVIRONMENT === "dev" && env.DESK_DEV_BYPASS === "1") return { email: null };
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw unauthorized();
  try {
    return await verifyAccessJwt(env, token);
  } catch {
    // Bad base64, bad JSON, a JWKS that will not load: all the same answer, and nothing about why.
    throw unauthorized();
  }
}
