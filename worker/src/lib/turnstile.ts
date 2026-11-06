// Server-side Turnstile check. Any doubt (network, odd answer) counts as not verified: the gate fails closed.

// Cloudflare documents tokens of at most 2048 characters; anything else is refused without a network call.
export const hasTurnstileToken = (t: unknown): t is string => typeof t === "string" && t.length > 0 && t.length <= 2048;

export async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (!hasTurnstileToken(token) || !env.TURNSTILE_SECRET) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return res.ok && ((await res.json()) as { success?: unknown } | null)?.success === true;
  } catch {
    return false;
  }
}
