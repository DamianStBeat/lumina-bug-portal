// The worker: one router for /api/v1 (CONTRACT.md "HTTP API"), CORS for the public routes, and the retention cron.
import { runRetention } from "./cron";
import { API_BASE, apiPath, errorResponse, HttpError, type RouteHandler } from "./lib/http";
import { handleAgent } from "./routes/agent";
import { handleDesk } from "./routes/desk";
import { handleGame } from "./routes/game";
import { handlePublic } from "./routes/public";
import { handleUploads } from "./routes/uploads";

// Each module answers only its own paths (null otherwise), so the order does not matter.
const MODULES: RouteHandler[] = [handlePublic, handleUploads, handleGame, handleAgent, handleDesk];

// Only what the web form calls from a browser gets CORS; game, agent and desk are server-to-server or same-site.
const isPublicPath = (p: string) => p === "/reports" || /^\/(reports|attachments|status)\//.test(p);

/** The request's origin when ALLOWED_ORIGINS lists it exactly (no prefix or suffix matching), else null. */
function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  const listed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  return origin && listed.includes(origin) ? origin : null;
}

function withCors(res: Response, origin: string | null): Response {
  // A copy: responses built elsewhere (fetch results, some R2 bodies) can have immutable headers.
  const out = new Response(res.body, res);
  out.headers.append("Vary", "Origin");
  if (origin) out.headers.set("Access-Control-Allow-Origin", origin);
  return out;
}

const preflightHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Report-Token",
  "Access-Control-Max-Age": "600",
};

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  for (const handle of MODULES) {
    const res = await handle(req, env, ctx, url);
    if (res) return res;
  }
  return errorResponse(404, "not_found");
}

async function fetchHandler(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${API_BASE}/`)) return errorResponse(404, "not_found");
  const isPublic = isPublicPath(apiPath(url));
  const origin = isPublic ? allowedOrigin(req, env) : null;
  // Other origins get a bare 204: without Allow-* headers the browser blocks the real request.
  if (isPublic && req.method === "OPTIONS") return withCors(new Response(null, { status: 204, headers: origin ? preflightHeaders : {} }), origin);

  let res: Response;
  try {
    res = await route(req, env, ctx, url);
  } catch (err) {
    if (err instanceof HttpError) res = errorResponse(err.status, err.code, err.extra);
    else {
      // The message only: never a request body, a token or a stack, in the log or in the answer.
      console.error("internal error", req.method, apiPath(url), err instanceof Error ? err.message : String(err));
      res = errorResponse(500, "internal");
    }
  }
  return isPublic ? withCors(res, origin) : res;
}

export default {
  fetch: fetchHandler,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Env>;
