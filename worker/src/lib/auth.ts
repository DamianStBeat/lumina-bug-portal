// Hashes, constant-time comparison and the three credentials of the API: game key, agent key, report tokens.
import { HttpError } from "./http";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Looks at every character whatever the first difference, so the time taken says nothing about the secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Hashing both sides first gives equal-length inputs, so neither the key's length nor a prefix leaks. An empty
 * configured secret never matches: a forgotten `wrangler secret put` locks the route instead of opening it.
 */
export async function secretMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  return constantTimeEqual(await sha256Hex(given), await sha256Hex(expected));
}

/** 401 `unauthorized` unless the X-Game-Key header is GAME_KEY. */
export async function requireGameKey(env: Env, req: Request): Promise<void> {
  if (!(await secretMatches(req.headers.get("X-Game-Key"), env.GAME_KEY))) throw new HttpError(401, "unauthorized");
}

/** 401 `unauthorized` unless the header is `Authorization: Bearer <AGENT_KEY>`. */
export async function requireAgentKey(env: Env, req: Request): Promise<void> {
  const header = req.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!(await secretMatches(given, env.AGENT_KEY))) throw new HttpError(401, "unauthorized");
}

/** 32 random bytes, base64url without padding (43 characters). Only its sha256Hex is ever stored. */
export function newReportToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 401 `invalid_token` unless `token` (the X-Report-Token header) belongs to the report: its creation token
 * (`reports.report_token_hash`) or one issued by attach-session (`report_tokens`). `target` is the report id or an
 * attachment row (its `report_id`). Every stored hash is compared, with no early exit on a match.
 */
export async function requireReportToken(env: Env, target: string | { report_id: string }, token: string | null) {
  if (!token) throw new HttpError(401, "invalid_token");
  const given = await sha256Hex(token);
  const { results } = await env.DB.prepare(
    "SELECT report_token_hash AS h FROM reports WHERE id = ?1 UNION ALL SELECT token_hash FROM report_tokens WHERE report_id = ?1",
  )
    .bind(typeof target === "string" ? target : target.report_id)
    .all<{ h: string }>();
  let ok = false;
  for (const row of results) ok = constantTimeEqual(given, row.h) || ok;
  if (!ok) throw new HttpError(401, "invalid_token");
}
