// Desk routes for the team (CONTRACT.md "HTTP API" > Desk): the report list, one report, the video stream with Range,
// and a status change. Every one of them passes requireDeskAccess first; none sends CORS headers.
import { type DeskIdentity, requireDeskAccess } from "../lib/access";
import { CODE_PATTERN } from "../lib/codes";
import { duplicateTarget, linkDuplicate } from "../lib/duplicates";
import { apiPath, dispatch, errorResponse, HttpError, json, readJson, type Route, type RouteHandler } from "../lib/http";
import { reportOf } from "../lib/reports";
import * as v from "../lib/validate";

const PAGE_SIZE = 50;
const ID_PATTERN = "[0-9A-Za-z-]{1,64}";

/**
 * The desk's tabs as SQL conditions. CONTRACT.md names the tabs, not their meaning; this mapping is the lead's:
 * - fix_ready: triage said simple_fix, the agent opened a PR, and nobody has closed the report yet (status looking);
 * - needs_person: triage said needs_person and the report is still open (looking);
 * - duplicate / not_bug: by status, whatever the verdict was, so a person's decision wins over triage;
 * - waiting: received, not looked at yet; all: everything.
 * Constant strings only: the request picks a key, never SQL text.
 */
const FILTERS: Record<string, string> = {
  all: "1 = 1",
  fix_ready: "r.verdict = 'simple_fix' AND r.pr_url IS NOT NULL AND r.status = 'looking'",
  needs_person: "r.verdict = 'needs_person' AND r.status = 'looking'",
  duplicate: "r.status = 'duplicate'",
  not_bug: "r.status = 'not_bug'",
  waiting: "r.status = 'received'",
};

// The cursor is opaque to the desk: base64url of [created_at, id] of the last row shown.
const encodeCursor = (createdAt: number, id: string) =>
  btoa(JSON.stringify([createdAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeCursor(raw: string): [number, string] {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const parsed: unknown = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
    if (Array.isArray(parsed) && parsed.length === 2 && Number.isSafeInteger(parsed[0])) {
      if (typeof parsed[1] === "string" && new RegExp(`^${ID_PATTERN}$`).test(parsed[1])) return [parsed[0], parsed[1]];
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new HttpError(400, "invalid_cursor");
}

async function listReports(env: Env, url: URL): Promise<Response> {
  const filter = url.searchParams.get("filter") ?? "all";
  if (!Object.hasOwn(FILTERS, filter)) throw new HttpError(400, "invalid_filter");
  const cursor = url.searchParams.get("cursor");
  const after = cursor ? decodeCursor(cursor) : null;
  // Newest first, with id as the tie-break so two reports in the same millisecond are neither skipped nor repeated.
  const keyset = after ? "AND (r.created_at < ?1 OR (r.created_at = ?1 AND r.id < ?2))" : "";
  // The count is the player's files (frames are the agent's) that did not end as an aborted upload.
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.code, r.created_at, r.updated_at, r.source, r.status, r.verdict, r.title,
       substr(r.what, 1, 200) AS what, r.where_area, r.device,
       (SELECT count(*) FROM attachments a WHERE a.report_id = r.id AND a.kind IN ('video', 'image')
          AND a.status != 'aborted') AS attachment_count
     FROM reports r WHERE ${FILTERS[filter]} ${keyset}
     ORDER BY r.created_at DESC, r.id DESC LIMIT ${PAGE_SIZE + 1}`,
  )
    .bind(...(after ?? []))
    .all<{ id: string; created_at: number } & Record<string, unknown>>();
  const page = results.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor = results.length > PAGE_SIZE && last ? encodeCursor(last.created_at, last.id) : null;
  return json({ reports: page.map(({ id: _id, ...row }) => row), nextCursor });
}

/** A stored JSON column as data; a value that does not parse is shown as its text rather than hiding the report. */
function parsed(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getReport(env: Env, code: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE code = ?").bind(code).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found");
  const { report_token_hash: _token, ip_hash: _ip, ...report } = row;
  // Frames included (kind frames); R2 keys and upload ids stay inside the worker.
  const attachments = await env.DB.prepare(
    `SELECT id, kind, filename, mime, size_bytes, status, created_at, completed_at
     FROM attachments WHERE report_id = ? ORDER BY created_at, id`,
  )
    .bind(row.id)
    .all();
  const duplicates = await env.DB.prepare("SELECT code FROM reports WHERE duplicate_of = ? ORDER BY created_at LIMIT 200")
    .bind(code)
    .all<{ code: string }>();
  return json({
    report: { ...report, triage: parsed(report.triage), game_context: parsed(report.game_context) },
    attachments: attachments.results,
    duplicates: duplicates.results.map((d) => d.code),
  });
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * One `bytes=` range against an object of `size` bytes (RFC 9110 14.1.2). Null means "ignore the header and send
 * everything": a malformed value or several ranges, which a video player never needs.
 */
function parseRange(header: string | null, size: number): ByteRange {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const first = m[1] === "" ? null : Number(m[1]);
  const last = m[2] === "" ? null : Number(m[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) {
    // bytes=-n: the last n bytes.
    if (last === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last!), end: size - 1 };
  }
  if (last !== null && last < first) return null;
  if (first >= size) return "unsatisfiable";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** A player declared the mime; only video/* and image/* shapes go back out, anything else is plain bytes. */
const safeMime = (mime: string) => (/^(video|image)\/[A-Za-z0-9.+-]{1,60}$/.test(mime) ? mime : "application/octet-stream");

async function streamAttachment(req: Request, env: Env, id: string): Promise<Response> {
  const a = await env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE id = ? AND status = 'complete'")
    .bind(id)
    .first<{ r2_key: string; mime: string }>();
  const head = a ? await env.FILES.head(a.r2_key) : null;
  if (!a || !head) throw new HttpError(404, "not_found");
  const headers = new Headers({
    "Content-Type": safeMime(a.mime),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    // Player files are untrusted: never sniffed into something else, never run as a page if opened directly.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
  const range = parseRange(req.headers.get("Range"), head.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  const length = range ? range.end - range.start + 1 : head.size;
  const object = await env.FILES.get(a.r2_key, range ? { range: { offset: range.start, length } } : {});
  if (!object) throw new HttpError(404, "not_found");
  headers.set("Content-Length", String(length));
  if (!range) return new Response(object.body, { status: 200, headers });
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(object.body, { status: 206, headers });
}

async function setStatus(req: Request, env: Env, code: string, who: DeskIdentity): Promise<Response> {
  const body = await readJson(req);
  const status = v.oneOf(body.status, "status", v.STATUSES);
  if (!status) throw new HttpError(400, "invalid_status");
  const pr = v.prUrl(body.prUrl);
  const note = v.text(body.note, "note", 0, 2000);
  // `duplicate` by hand goes through triage's guarded link write (lib/duplicates.ts); any other status clears it below.
  const dup = duplicateTarget(status === "duplicate", body.duplicateOf, code);
  if (dup !== null) {
    await linkDuplicate(env, code, dup, {
      set: "pr_url = COALESCE(?, pr_url), ",
      setBinds: [pr],
      eventPairs: ", 'note', ?, 'prUrl', ?, 'by', 'desk', 'email', ?",
      eventBinds: [note, pr, who.email],
      onlyOnChange: false,
      events: [],
    });
    return json({ ok: true });
  }
  const report = await reportOf(env, code);
  const now = Date.now();
  // One transaction, the event first: its `from` is read from the row inside the transaction, so a change landing
  // between our lookup and this batch can never be recorded with a stale previous status. Leaving `duplicate` clears
  // the link: a stale one would come back, unguarded, if the report were set back later.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (report_id, at, type, data)
       SELECT id, ?2, 'status_changed', json_object('from', status, 'to', ?3, 'note', ?4, 'prUrl', ?5, 'by', 'desk', 'email', ?6)
       FROM reports WHERE id = ?1`,
    ).bind(report.id, now, status, note, pr, who.email),
    env.DB.prepare("UPDATE reports SET status = ?2, pr_url = COALESCE(?3, pr_url), duplicate_of = NULL, updated_at = ?4 WHERE id = ?1").bind(
      report.id,
      status,
      pr,
      now,
    ),
  ]);
  return json({ ok: true });
}

const routes = (who: DeskIdentity): Route[] => [
  { method: "GET", pattern: /^\/desk\/reports$/, handle: (_r, env, _c, url) => listReports(env, url) },
  {
    method: "GET",
    pattern: new RegExp(`^/desk/reports/(${CODE_PATTERN})$`),
    handle: (_r, env, _c, _u, [code]) => getReport(env, code!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/desk/attachments/(${ID_PATTERN})/stream$`),
    handle: (req, env, _c, _u, [id]) => streamAttachment(req, env, id!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/desk/reports/(${CODE_PATTERN})/status$`),
    handle: (req, env, _c, _u, [code]) => setStatus(req, env, code!, who),
  },
];

/** Access first, for every /desk path (unknown ones too), so nothing about the desk answers a stranger. */
export const handleDesk: RouteHandler = async (req, env, ctx, url) => {
  const path = apiPath(url);
  if (path !== "/desk" && !path.startsWith("/desk/")) return null;
  const who = await requireDeskAccess(env, req);
  return (await dispatch(routes(who), req, env, ctx, url)) ?? errorResponse(404, "not_found");
};
