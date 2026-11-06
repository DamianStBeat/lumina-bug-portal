// Fixed hourly rate limits in the D1 `rate` table (CONTRACT.md "Limits" > Rate) and the salted ip hash.
import { sha256Hex } from "./auth";
import { HttpError } from "./http";

export const RATE_WINDOW_MS = 3_600_000;

/**
 * Counts this request under `key` and refuses it with 429 `rate_limited` once the count is over `limit` in the
 * current window (`rate.window` = window start, unix ms). Increment and read are one statement, so two requests at
 * once can never both take the last free slot. Refused requests count too: whoever keeps hammering stays refused.
 */
export async function enforceRate(env: Env, key: string, limit: number, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare(
    'INSERT INTO rate (key, "window", count) VALUES (?, ?, 1) ON CONFLICT (key, "window") DO UPDATE SET count = count + 1 RETURNING count',
  )
    .bind(key, Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS)
    .first<{ count: number }>();
  if (!row) throw new Error("rate: upsert returned no count");
  if (row.count > limit) throw new HttpError(429, "rate_limited");
}

/** Cloudflare always sets the header in production; requests without it (local tools) share one bucket. */
export const clientIp = (req: Request): string => req.headers.get("CF-Connecting-IP") ?? "unknown";

/**
 * sha256(ip + daily salt), the salt derived from IP_SALT_SEED and the UTC date: a network is recognisable within a
 * day (enough for hourly limits), not across days. At midnight UTC it gets a fresh bucket, at worst two hours' worth.
 */
export async function ipHash(env: Env, req: Request, now = Date.now()): Promise<string> {
  const salt = await sha256Hex(`${env.IP_SALT_SEED}:${new Date(now).toISOString().slice(0, 10)}`);
  return sha256Hex(clientIp(req) + salt);
}
