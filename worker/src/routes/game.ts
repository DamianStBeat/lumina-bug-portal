// Game routes (CONTRACT.md "Game"): a Lumina2 server files a report for a player and lists that player's reports.
import { requireGameKey } from "../lib/auth";
import { gameContext } from "../lib/gamecontext";
import { apiPath, dispatch, HttpError, json, readJson, type Route, type RouteHandler } from "../lib/http";
import { enforceRate } from "../lib/rate";
import { insertReport } from "../lib/reports";
import { resolvePublicStatus } from "../lib/status";
import * as v from "../lib/validate";

// Room for a context the server did not trim yet (80 error lines of 300 characters); what is stored stays <= 16 KB.
const MAX_BODY = 64 * 1024;

/** The Roblox user id: it comes from the game server, not the player, but a bad one must still never be stored. */
function userId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, "invalid_user_id");
  return value;
}

/** Fields, then rate, then the write: a malformed request costs the player no rate slot. */
async function createReport(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req, MAX_BODY);
  const fields = {
    roblox_user_id: userId(body.userId),
    roblox_name: v.text(body.userName, "user_name", 0, 20),
    title: v.title(body.title),
    what: v.what(body.what),
    lang: v.lang(body.lang),
    game_context: gameContext(body.context),
  };
  await enforceRate(env, `game:${fields.roblox_user_id}`, 5);
  // insertReport also stores a fresh token hash (the column is NOT NULL); the game never receives the token.
  const { code } = await insertReport(env, { source: "game", ...fields });
  return json({ code }, 201);
}

/** The player's last 10 reports, newest first, each with the status the player may see (never the internal one). */
async function listReports(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("userId") ?? "";
  const id = userId(/^\d{1,16}$/.test(raw) ? Number(raw) : NaN);
  const { results } = await env.DB.prepare(
    "SELECT code, title, status, duplicate_of, updated_at FROM reports WHERE roblox_user_id = ? ORDER BY created_at DESC, code LIMIT 10",
  )
    .bind(id)
    .all<{ code: string; title: string | null; status: string; duplicate_of: string | null; updated_at: number }>();
  const reports = await Promise.all(
    results.map(async (row) => {
      const shown = await resolvePublicStatus(env, row);
      return { code: row.code, title: row.title, status: shown.status, updatedAt: shown.updatedAt };
    }),
  );
  return json({ reports });
}

const ROUTES: Route[] = [
  { method: "POST", pattern: /^\/game\/reports$/, handle: (req, env) => createReport(req, env) },
  { method: "GET", pattern: /^\/game\/reports$/, handle: (_req, env, _ctx, url) => listReports(env, url) },
];

// The key is checked before any routing, so without it no /game path reveals whether it exists.
export const handleGame: RouteHandler = async (req, env, ctx, url) => {
  if (!apiPath(url).startsWith("/game/")) return null;
  await requireGameKey(env, req);
  return dispatch(ROUTES, req, env, ctx, url);
};
