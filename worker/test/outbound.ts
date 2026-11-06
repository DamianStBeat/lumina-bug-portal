// Every outbound HTTP call of the worker goes through this stub (installed for each test by setup.ts).
// Known hosts get a fake answer that checks what the worker sent; anything else is recorded and fails the test.
import { env } from "cloudflare:workers";

// Cloudflare's documented dummy token: the only one our fake siteverify accepts.
export const TURNSTILE_PASS = "XXXX.DUMMY.TOKEN.XXXX";
export const TURNSTILE_FAIL = "turnstile-token-the-fake-rejects";

export const outbound = {
  unexpected: [] as string[],
  turnstileCalls: 0,
  /** JWKS served at https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs; null answers 404. */
  jwks: null as null | { keys: JsonWebKey[] },
};

async function readSiteverifyBody(req: Request): Promise<{ secret: string | null; response: string | null }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    return {
      secret: typeof body.secret === "string" ? body.secret : null,
      response: typeof body.response === "string" ? body.response : null,
    };
  }
  const form = await req.formData();
  const secret = form.get("secret");
  const response = form.get("response");
  return {
    secret: typeof secret === "string" ? secret : null,
    response: typeof response === "string" ? response : null,
  };
}

export async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.host === "challenges.cloudflare.com" && url.pathname === "/turnstile/v0/siteverify") {
    outbound.turnstileCalls += 1;
    const { secret, response } = await readSiteverifyBody(req);
    const success = req.method === "POST" && secret === env.TURNSTILE_SECRET && response === TURNSTILE_PASS;
    return Response.json(
      success
        ? { success: true, "error-codes": [], hostname: "bugs.lumina.test" }
        : { success: false, "error-codes": ["invalid-input-response"] },
    );
  }
  if (url.host === env.ACCESS_TEAM_DOMAIN && url.pathname === "/cdn-cgi/access/certs") {
    return outbound.jwks ? Response.json(outbound.jwks) : new Response("not found", { status: 404 });
  }
  outbound.unexpected.push(`${req.method} ${req.url}`);
  throw new Error(`unexpected outbound fetch in a test: ${req.method} ${req.url}`);
}
