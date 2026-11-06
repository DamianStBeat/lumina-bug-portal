// Creating a report, shared by the web, game and Discord routes: one row and its `created` event in one batch. Also
// the lookup by code the agent and desk routes share.
import { newReportToken, sha256Hex } from "./auth";
import { ulid, withNewCode } from "./codes";
import { eventStatement } from "./events";
import { HttpError } from "./http";

// Fixed column list: the SQL text never depends on the caller's object, only the bound values do.
const OPTIONAL = ["title", "where_area", "device", "lang", "roblox_name", "roblox_user_id", "discord_user_id",
  "discord_name", "discord_thread_id", "game_context", "ip_hash"] as const;
const INSERT_SQL = `INSERT INTO reports (id, code, created_at, updated_at, source, status, what, report_token_hash,
  ${OPTIONAL.join(", ")}) VALUES (${Array(8 + OPTIONAL.length).fill("?").join(", ")})`;

/** Columns a creating route may fill, already validated; id, code, times, status `received` and token are set here. */
export type NewReportFields = { source: "web" | "game" | "discord"; what: string } & {
  [K in (typeof OPTIONAL)[number]]?: string | number | null;
};

export async function insertReport(env: Env, fields: NewReportFields) {
  const reportToken = newReportToken();
  const tokenHash = await sha256Hex(reportToken);
  return withNewCode(async (code) => {
    const now = Date.now();
    const id = ulid(now);
    const values = OPTIONAL.map((col) => fields[col] ?? null);
    // D1 runs a batch as one transaction: never a report without its `created` event, or the reverse.
    await env.DB.batch([
      env.DB.prepare(INSERT_SQL).bind(id, code, now, now, fields.source, "received", fields.what, tokenHash, ...values),
      eventStatement(env, id, "created", { source: fields.source }, now),
    ]);
    return { id, code, reportToken };
  });
}

/** The report's id and status by code, or 404 `not_found`. */
export async function reportOf(env: Env, code: string): Promise<{ id: string; status: string }> {
  const row = await env.DB.prepare("SELECT id, status FROM reports WHERE code = ?").bind(code).first<{ id: string; status: string }>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}
