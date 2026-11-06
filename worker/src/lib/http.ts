// Responses, the error every route throws, safe JSON bodies and the small route table all route modules share.

export const API_BASE = "/api/v1";

/** What a few refusals add to `{error: code}`: fields the caller acts on (e.g. `retryAfter`) and their headers. */
export type ErrorExtra = { body?: Record<string, unknown>; headers?: Record<string, string> };

/** A refusal the router turns into `{error: code}` with this status. Codes are snake_case and safe to show. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra?: ErrorExtra) {
    super(code);
  }
}

export const json = (data: unknown, status = 200): Response => Response.json(data, { status });
// `error` last, so an extra field can never replace the code.
export const errorResponse = (status: number, code: string, extra?: ErrorExtra): Response =>
  Response.json({ ...extra?.body, error: code }, { status, headers: extra?.headers });

/** At most `maxBytes` of the body, read in chunks and stopped early, so a huge body never sits in memory; else 413. */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(req.headers.get("Content-Length") ?? 0) > maxBytes) throw new HttpError(413, "body_too_large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  for (let r = await reader?.read(); reader && r && !r.done; r = await reader.read()) {
    total += r.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  chunks.reduce((at, c) => (out.set(c, at), at + c.byteLength), 0);
  return out;
}

/** A JSON object body, or 400 `invalid_json` (arrays and scalars too: no route accepts them). */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "invalid_json");
  return parsed as Record<string, unknown>;
}

/** Every route module exports one of these; `null` means "not my path", so the router asks the next module. */
export type RouteHandler = (req: Request, env: Env, ctx: ExecutionContext, url: URL) => Promise<Response | null>;

/** One endpoint. `pattern` is tested on the path after /api/v1 and must admit only safe characters: its capture
 * groups arrive raw as `params` (no decodeURIComponent, which throws on bad escapes). */
export type Route = {
  method: string;
  pattern: RegExp;
  handle: (req: Request, env: Env, ctx: ExecutionContext, url: URL, params: string[]) => Promise<Response>;
};

export const apiPath = (url: URL): string => url.pathname.slice(API_BASE.length);

/** Runs the route whose pattern and method match; a known path with another method is 405. */
export async function dispatch(routes: Route[], req: Request, env: Env, ctx: ExecutionContext, url: URL) {
  const path = apiPath(url);
  const matching = routes.filter((r) => r.pattern.test(path));
  const route = matching.find((r) => r.method === req.method);
  if (route) return route.handle(req, env, ctx, url, route.pattern.exec(path)!.slice(1));
  if (matching.length > 0) throw new HttpError(405, "method_not_allowed");
  return null;
}
