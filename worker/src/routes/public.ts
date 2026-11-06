// Public routes of the web form: POST /reports, POST /reports/{code}/attach-session, GET /status/{code}.
import { newReportToken, sha256Hex } from "../lib/auth";
import { CODE_PATTERN } from "../lib/codes";
import { dispatch, HttpError, json, readJson, type Route, type RouteHandler } from "../lib/http";
import { clientIp, enforceRate, ipHash } from "../lib/rate";
import { insertReport } from "../lib/reports";
import { resolvePublicStatus } from "../lib/status";
import { hasTurnstileToken, verifyTurnstile } from "../lib/turnstile";
import * as v from "../lib/validate";

/**
 * Cheapest refusal first, and nothing but the rate counter is written before every check has passed:
 * 1. body and fields (no I/O): a malformed request costs neither a rate slot nor a siteverify call;
 * 2. rate limit (one D1 upsert), before Turnstile, so a flood from one network stops costing siteverify calls
 *    after a few tries, and a failed Turnstile still uses a slot, which limits token guessing too;
 * 3. Turnstile (network); 4. the writes.
 */
async function gate(req: Request, env: Env, body: Record<string, unknown>, bucket: string, limit: number) {
  if (!hasTurnstileToken(body.turnstileToken)) throw new HttpError(403, "turnstile_failed");
  const hash = await ipHash(env, req);
  await enforceRate(env, `${bucket}:${hash}`, limit);
  if (!(await verifyTurnstile(env, body.turnstileToken, clientIp(req)))) throw new HttpError(403, "turnstile_failed");
  return hash;
}

async function createReport(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const fields = {
    what: v.what(body.what),
    where_area: v.oneOf(body.where, "where", v.WHERE_AREAS),
    device: v.oneOf(body.device, "device", v.DEVICES),
    lang: v.lang(body.lang),
    roblox_name: v.robloxName(body.robloxName),
  };
  const hash = await gate(req, env, body, "web", 5);
  const { code, reportToken } = await insertReport(env, { source: "web", ...fields, ip_hash: hash });
  return json({ code, reportToken }, 201);
}

/**
 * A new token for an existing report (a player adding files later, maybe from another device). Earlier tokens stay
 * valid: each new one is a `report_tokens` row, which requireReportToken checks next to the creation token.
 */
async function attachSession(req: Request, env: Env, code: string): Promise<Response> {
  await gate(req, env, await readJson(req), "attach", 10);
  // Looked up after Turnstile: only a verified visitor learns whether the code exists here.
  const report = await env.DB.prepare("SELECT id FROM reports WHERE code = ?").bind(code).first<{ id: string }>();
  if (!report) throw new HttpError(404, "not_found");
  const reportToken = newReportToken();
  await env.DB.prepare("INSERT INTO report_tokens (report_id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(report.id, await sha256Hex(reportToken), Date.now())
    .run();
  return json({ reportToken });
}

async function status(env: Env, code: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT code, status, duplicate_of, updated_at FROM reports WHERE code = ?")
    .bind(code)
    .first<{ code: string; status: string; duplicate_of: string | null; updated_at: number }>();
  if (!row) throw new HttpError(404, "not_found");
  const shown = await resolvePublicStatus(env, row);
  return json({ code: row.code, status: shown.status, updatedAt: shown.updatedAt });
}

// A malformed code matches no pattern and gets the router's 404 `not_found`, like an unknown code.
const ROUTES: Route[] = [
  { method: "POST", pattern: /^\/reports$/, handle: (req, env) => createReport(req, env) },
  {
    method: "POST",
    pattern: new RegExp(`^/reports/(${CODE_PATTERN})/attach-session$`),
    handle: (req, env, _ctx, _url, [code]) => attachSession(req, env, code!),
  },
  { method: "GET", pattern: new RegExp(`^/status/(${CODE_PATTERN})$`), handle: (_r, env, _c, _u, [code]) => status(env, code!) },
];

export const handlePublic: RouteHandler = (req, env, ctx, url) => dispatch(ROUTES, req, env, ctx, url);
