// Agent and bot routes (CONTRACT.md "Agent and bot"): the Valor1 triage agent and the Discord bot, bearer AGENT_KEY.
import { requireAgentKey } from "../lib/auth";
import { CODE_PATTERN, ulid } from "../lib/codes";
import { duplicateTarget, linkDuplicate } from "../lib/duplicates";
import { eventStatement } from "../lib/events";
import { apiPath, dispatch, HttpError, json, readBody, readJson, type Route, type RouteHandler } from "../lib/http";
import { enforceRate } from "../lib/rate";
import { insertReport, reportOf } from "../lib/reports";
import * as v from "../lib/validate";

const MINUTE = 60_000;
// An upload younger than this may still be running: triaging now would miss the video the player is sending.
const UPLOAD_GRACE_MS = 30 * MINUTE;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_TRIAGE_BYTES = 32 * 1024;
// The first bytes of each accepted frame type: the desk serves frames to browsers under the declared type.
const FRAME_MAGIC: Record<string, number[]> = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47] };
// Discord ids are 64-bit snowflakes: strings, since they do not fit a JS number.
const SNOWFLAKE = /^\d{1,20}$/;

/** `?name=` as a whole number >= min: `fallback` when absent, capped at `max`, else 400 `invalid_<name>`. */
function intParam(url: URL, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= min)) throw new HttpError(400, `invalid_${name}`);
  return Math.min(n, max);
}

function snowflake(value: unknown, field: string, required: boolean): string | null {
  if (!required && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !SNOWFLAKE.test(value)) throw new HttpError(400, `invalid_${field}`);
  return value;
}

/** Stored JSON back to a value; text we did not write as JSON comes back as null instead of failing the route. */
function parseStored(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function queue(env: Env, url: URL): Promise<Response> {
  const limit = intParam(url, "limit", 10, 1, 50);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT code, created_at, source FROM reports r
     WHERE status = 'received' AND (lease_until IS NULL OR lease_until <= ?1)
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.report_id = r.id AND a.status = 'uploading' AND a.created_at > ?2)
     ORDER BY created_at, code LIMIT ?3`,
  )
    .bind(now, now - UPLOAD_GRACE_MS, limit)
    .all<{ code: string; created_at: number; source: string }>();
  return json({ reports: results.map((r) => ({ code: r.code, createdAt: r.created_at, source: r.source })) });
}

async function claim(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req);
  const by = v.text(body.by, "by", 1, 64)!;
  const minutes = body.minutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new HttpError(400, "invalid_minutes");
  }
  const now = Date.now();
  // One conditional statement, never read-then-write: of two agents claiming at once exactly one gets the row back.
  const won = await env.DB.prepare(
    "UPDATE reports SET lease_until = ?1, lease_by = ?2 WHERE code = ?3 AND (lease_until IS NULL OR lease_until <= ?4) RETURNING lease_until",
  )
    .bind(now + minutes * MINUTE, by, code, now)
    .first<{ lease_until: number }>();
  if (won) return json({ leaseUntil: won.lease_until });
  await reportOf(env, code);
  throw new HttpError(409, "leased");
}

// An allow-list rather than `*` minus two: a secret column added later stays out of this answer by default.
const REPORT_COLUMNS = `id, code, created_at, updated_at, source, status, title, what, where_area, device, lang, roblox_name,
  roblox_user_id, discord_user_id, discord_name, discord_thread_id, game_context, verdict, triage, duplicate_of, pr_url,
  lease_until, lease_by`;

async function report(env: Env, code: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${REPORT_COLUMNS} FROM reports WHERE code = ?`)
    .bind(code)
    .first<{ id: string; game_context: string | null; triage: string | null }>();
  if (!row) throw new HttpError(404, "not_found");
  const { results } = await env.DB.prepare(
    "SELECT id, kind, filename, mime, size_bytes, status, created_at, completed_at FROM attachments WHERE report_id = ? ORDER BY created_at, id",
  )
    .bind(row.id)
    .all();
  return json({ ...row, game_context: parseStored(row.game_context), triage: parseStored(row.triage), attachments: results });
}

async function download(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE id = ? AND status = 'complete'")
    .bind(id)
    .first<{ r2_key: string; mime: string }>();
  const object = row ? await env.FILES.get(row.r2_key) : null;
  if (!row || !object) throw new HttpError(404, "not_found");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? row.mime,
      "Content-Length": String(object.size),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** X-Filename reduced to letters, digits, dot, dash and underscore, no leading dot, <= 120 chars, else a default. */
function frameName(raw: string | null, mime: string): string {
  const name = (raw ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120);
  return name || (mime === "image/png" ? "frame.png" : "frame.jpg");
}

async function frames(req: Request, env: Env, code: string): Promise<Response> {
  const mime = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  const magic = FRAME_MAGIC[mime];
  if (!magic) throw new HttpError(400, "invalid_mime");
  // The report first: an unknown code costs no 10 MB read.
  const report = await reportOf(env, code);
  const bytes = await readBody(req, MAX_FRAME_BYTES);
  if (!magic.every((b, i) => bytes[i] === b)) throw new HttpError(400, "invalid_mime");
  const id = ulid();
  const key = `frames/${report.id}/${id}`;
  const now = Date.now();
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  const data = JSON.stringify({ attachmentId: id, kind: "frames", size: bytes.byteLength });
  let added: boolean;
  try {
    // One transaction: the row and its file_added event land together. The row only while the report still exists
    // (retention may have removed it since our lookup, and would never find a row added after that), the event only
    // when the row was written.
    const [row] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO attachments (id, report_id, created_at, kind, filename, mime, size_bytes, r2_key, status, completed_at)
         SELECT ?1, id, ?2, 'frames', ?3, ?4, ?5, ?6, 'complete', ?2 FROM reports WHERE id = ?7`,
      ).bind(id, now, frameName(req.headers.get("X-Filename"), mime), mime, bytes.byteLength, key, report.id),
      env.DB.prepare(
        "INSERT INTO events (report_id, at, type, data) SELECT ?1, ?2, 'file_added', ?3 WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ?4)",
      ).bind(report.id, now, data, id),
    ]);
    added = row!.meta.changes === 1;
  } catch (err) {
    // No row points at the object, so retention would never find it: remove it now.
    await env.FILES.delete(key);
    throw err;
  }
  if (!added) {
    await env.FILES.delete(key);
    throw new HttpError(404, "not_found");
  }
  return json({ attachmentId: id }, 201);
}

async function triage(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req, 2 * MAX_TRIAGE_BYTES);
  const verdict = v.oneOf(body.verdict, "verdict", v.VERDICTS);
  if (!verdict) throw new HttpError(400, "invalid_verdict");
  const isObject = typeof body.triage === "object" && body.triage !== null && !Array.isArray(body.triage);
  const triageText = JSON.stringify(body.triage ?? null);
  if (!isObject || new TextEncoder().encode(triageText).byteLength > MAX_TRIAGE_BYTES) throw new HttpError(400, "invalid_triage");
  // A link only on a duplicate verdict, to an existing other report: a stray duplicateOf is an agent bug, refused.
  const dup = duplicateTarget(verdict === "duplicate", body.duplicateOf, code);
  if (dup !== null) {
    await linkDuplicate(env, code, dup, {
      set: "verdict = ?, triage = ?, ",
      setBinds: [verdict, triageText],
      eventPairs: "",
      eventBinds: [],
      onlyOnChange: true,
      events: [{ type: "triaged", data: { verdict } }],
    });
    return json({ ok: true });
  }
  const status = verdict === "not_bug" ? "not_bug" : "looking";
  const report = await reportOf(env, code);
  const now = Date.now();
  // One batch is one transaction: the new status and its events land together or not at all. The status_changed
  // event goes first and reads `from` from the row inside the transaction, written only when the stored status
  // differs: a desk change landing after our lookup is never lost from the history the bot follows.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (report_id, at, type, data)
       SELECT id, ?, 'status_changed', json_object('from', status, 'to', ?) FROM reports WHERE id = ? AND status <> ?`,
    ).bind(now, status, report.id, status),
    env.DB.prepare("UPDATE reports SET verdict = ?, triage = ?, status = ?, duplicate_of = NULL, updated_at = ? WHERE id = ?")
      .bind(verdict, triageText, status, now, report.id),
    eventStatement(env, report.id, "triaged", { verdict }, now),
  ]);
  return json({ ok: true });
}

async function setStatus(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req);
  const status = v.oneOf(body.status, "status", v.STATUSES);
  if (!status) throw new HttpError(400, "invalid_status");
  const prUrl = v.prUrl(body.prUrl);
  const note = v.text(body.note, "note", 0, 2000);
  // `duplicate` by hand is a link like triage's, through the same guarded write; any other status clears it below.
  const dup = duplicateTarget(status === "duplicate", body.duplicateOf, code);
  if (dup !== null) {
    await linkDuplicate(env, code, dup, {
      set: "pr_url = COALESCE(?, pr_url), ",
      setBinds: [prUrl],
      eventPairs: ", 'note', ?, 'prUrl', ?",
      eventBinds: [note, prUrl],
      onlyOnChange: false,
      events: [],
    });
    return json({ ok: true });
  }
  const report = await reportOf(env, code);
  const now = Date.now();
  // The event first, its `from` read from the row inside the same transaction, as the desk's status route does.
  // Leaving `duplicate` clears the link: a stale one would come back, unguarded, if the report were set back later.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (report_id, at, type, data)
       SELECT id, ?2, 'status_changed', json_object('from', status, 'to', ?3, 'note', ?4, 'prUrl', ?5) FROM reports WHERE id = ?1`,
    ).bind(report.id, now, status, note, prUrl),
    env.DB.prepare("UPDATE reports SET status = ?, pr_url = COALESCE(?, pr_url), duplicate_of = NULL, updated_at = ? WHERE id = ?")
      .bind(status, prUrl, now, report.id),
  ]);
  return json({ ok: true });
}

/** A report the bot files for a Discord user; fields, then rate, then the write, as on the other create routes. */
async function createDiscord(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  if (body.source !== "discord") throw new HttpError(400, "invalid_source");
  const fields = {
    discord_user_id: snowflake(body.discordUserId, "discord_user_id", true)!,
    discord_name: v.text(body.discordName, "discord_name", 1, 100),
    discord_thread_id: snowflake(body.threadId, "thread_id", false),
    what: v.what(body.what),
    title: v.title(body.title),
    where_area: v.oneOf(body.where, "where", v.WHERE_AREAS),
  };
  await enforceRate(env, `discord:${fields.discord_user_id}`, 5);
  const { code, reportToken } = await insertReport(env, { source: "discord", ...fields });
  return json({ code, reportToken }, 201);
}

async function setThread(req: Request, env: Env, code: string): Promise<Response> {
  const threadId = snowflake((await readJson(req)).threadId, "thread_id", true);
  const done = await env.DB.prepare("UPDATE reports SET discord_thread_id = ? WHERE code = ?").bind(threadId, code).run();
  if (done.meta.changes === 0) throw new HttpError(404, "not_found");
  return json({ ok: true });
}

async function events(env: Env, url: URL): Promise<Response> {
  const after = intParam(url, "after", 0, 0);
  const limit = intParam(url, "limit", 100, 1, 500);
  // LEFT JOIN: an event whose report retention removed keeps its place in the sequence (code null), so no gap hides.
  const { results } = await env.DB.prepare(
    "SELECT e.seq, r.code, e.at, e.type, e.data FROM events e LEFT JOIN reports r ON r.id = e.report_id WHERE e.seq > ? ORDER BY e.seq LIMIT ?",
  )
    .bind(after, limit)
    .all<{ seq: number; code: string | null; at: number; type: string; data: string | null }>();
  return json({ events: results.map((e) => ({ ...e, data: parseStored(e.data) })), last: results.at(-1)?.seq ?? after });
}

const onCode = (suffix: string) => new RegExp(`^/agent/reports/(${CODE_PATTERN})${suffix}$`);
const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/agent\/queue$/, handle: (_r, env, _c, url) => queue(env, url) },
  { method: "POST", pattern: /^\/agent\/reports$/, handle: (req, env) => createDiscord(req, env) },
  { method: "GET", pattern: onCode(""), handle: (_r, env, _c, _u, [code]) => report(env, code!) },
  { method: "POST", pattern: onCode("/claim"), handle: (req, env, _c, _u, [code]) => claim(req, env, code!) },
  { method: "POST", pattern: onCode("/frames"), handle: (req, env, _c, _u, [code]) => frames(req, env, code!) },
  { method: "POST", pattern: onCode("/triage"), handle: (req, env, _c, _u, [code]) => triage(req, env, code!) },
  { method: "POST", pattern: onCode("/status"), handle: (req, env, _c, _u, [code]) => setStatus(req, env, code!) },
  { method: "POST", pattern: onCode("/discord"), handle: (req, env, _c, _u, [code]) => setThread(req, env, code!) },
  { method: "GET", pattern: /^\/agent\/attachments\/([A-Za-z0-9-]{1,64})\/download$/, handle: (_r, env, _c, _u, [id]) => download(env, id!) },
  { method: "GET", pattern: /^\/agent\/events$/, handle: (_r, env, _c, url) => events(env, url) },
];

// The key is checked before any routing, so without it no /agent path reveals whether it exists.
export const handleAgent: RouteHandler = async (req, env, ctx, url) => {
  if (!apiPath(url).startsWith("/agent/")) return null;
  await requireAgentKey(env, req);
  return dispatch(ROUTES, req, env, ctx, url);
};
