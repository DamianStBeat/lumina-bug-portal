// Player files (CONTRACT.md "Public", header X-Report-Token): POST /reports/{code}/attachments, PUT
// /attachments/{id}/parts/{n}, GET /attachments/{id}/parts, POST /attachments/{id}/complete, DELETE /attachments/{id}.
// Bytes go to R2 through the binding's multipart API; D1 keeps the attachment row and one `parts` row per part.
import { requireReportToken } from "../lib/auth";
import { CODE_PATTERN, ulid } from "../lib/codes";
import { dispatch, HttpError, json, readJson, type Route, type RouteHandler } from "../lib/http";
import {
  abortUpload,
  expectedPartSize,
  isNoSuchUpload,
  MAX_PLAYER_FILES,
  PART_SIZE,
  parseMime,
  parseSize,
  sanitizeFilename,
} from "../lib/uploads";

type Attachment = {
  id: string;
  report_id: string;
  kind: string;
  size_bytes: number;
  r2_key: string;
  upload_id: string | null;
  part_count: number | null;
  status: string;
};

const TOKEN_HEADER = "X-Report-Token";
// Ids are ulids here; the pattern stays loose (uuid rows from other writers) but admits only safe characters.
const ID = "[0-9A-Za-z-]{1,64}";
// Statuses that hold a slot of the three: an abandoned upload frees its slot only once deleted or aborted.
const LIVE = "status IN ('uploading', 'complete') AND kind IN ('video', 'image')";

/**
 * The attachment and a token check, in that order and before any body is read, so a request with a wrong token
 * costs one D1 read and writes nothing. Frames are the agent's: a report token neither sees nor changes them.
 */
async function authorized(req: Request, env: Env, id: string): Promise<Attachment> {
  const row = await env.DB.prepare(
    "SELECT id, report_id, kind, size_bytes, r2_key, upload_id, part_count, status FROM attachments WHERE id = ? AND kind IN ('video', 'image')",
  )
    .bind(id)
    .first<Attachment>();
  if (!row) throw new HttpError(404, "not_found");
  await requireReportToken(env, row, req.headers.get(TOKEN_HEADER));
  return row;
}

const uploadOf = (env: Env, a: Attachment) => env.FILES.resumeMultipartUpload(a.r2_key, a.upload_id ?? "");

async function createAttachment(req: Request, env: Env, code: string): Promise<Response> {
  // Codes are not secret (CONTRACT.md "Report code"), so answering 404 before the token check reveals nothing new.
  const report = await env.DB.prepare("SELECT id FROM reports WHERE code = ?").bind(code).first<{ id: string }>();
  if (!report) throw new HttpError(404, "not_found");
  await requireReportToken(env, report.id, req.headers.get(TOKEN_HEADER));

  const body = await readJson(req);
  const size = parseSize(body.size);
  const { mime, kind } = parseMime(body.mime);
  const filename = sanitizeFilename(body.filename);
  const countSql = `SELECT count(*) AS n FROM attachments WHERE report_id = ? AND ${LIVE}`;
  const live = await env.DB.prepare(countSql).bind(report.id).first<{ n: number }>();
  // Checked again in the insert below; this early answer only spares an R2 call for the common case.
  if ((live?.n ?? 0) >= MAX_PLAYER_FILES) throw new HttpError(400, "too_many_files");

  const id = ulid();
  // Built from ids only: the player's filename never reaches an R2 key.
  const key = `reports/${report.id}/${id}`;
  const partCount = Math.ceil(size / PART_SIZE);
  const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  const now = Date.now();
  // The count sits inside the insert, so two requests racing for the third slot cannot both win.
  const inserted = await env.DB.prepare(
    `INSERT INTO attachments (id, report_id, created_at, kind, filename, mime, size_bytes, r2_key, upload_id, part_size, part_count, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading' WHERE (${countSql}) < ?`,
  )
    .bind(id, report.id, now, kind, filename, mime, size, key, upload.uploadId, PART_SIZE, partCount, report.id, MAX_PLAYER_FILES)
    .run();
  if (inserted.meta.changes !== 1) {
    await upload.abort();
    throw new HttpError(400, "too_many_files");
  }
  await env.DB.prepare("UPDATE reports SET updated_at = ? WHERE id = ?").bind(now, report.id).run();
  return json({ attachmentId: id, partSize: PART_SIZE, partCount }, 201);
}

/**
 * The body is streamed to R2 through a FixedLengthStream of the exact part size, never buffered: a 16 MiB part
 * costs no Worker memory, and a body shorter or longer than declared makes the pipe fail, which is the real byte
 * count check. Content-Length, when sent, is checked first so an obviously wrong part is refused without a read.
 */
async function putPart(req: Request, env: Env, id: string, nText: string): Promise<Response> {
  const a = await authorized(req, env, id);
  if (a.status !== "uploading") throw new HttpError(409, "not_uploading");
  const n = Number(nText);
  const partCount = a.part_count ?? 0;
  if (!Number.isInteger(n) || n < 1 || n > partCount) throw new HttpError(400, "invalid_part");
  const expected = expectedPartSize(n, partCount, a.size_bytes);
  const declared = req.headers.get("Content-Length");
  if (declared !== null && Number(declared) !== expected) throw new HttpError(400, "invalid_part_size");

  const fixed = new FixedLengthStream(expected);
  const piped = req.body ? req.body.pipeTo(fixed.writable) : fixed.writable.close();
  const [pipe, sent] = await Promise.allSettled([piped, uploadOf(env, a).uploadPart(n, fixed.readable)]);
  if (pipe.status === "rejected") throw new HttpError(400, "invalid_part_size");
  if (sent.status === "rejected") {
    // Completed or aborted between our status read and the upload: the same answer as the check above.
    if (isNoSuchUpload(sent.reason)) throw new HttpError(409, "not_uploading");
    throw sent.reason;
  }
  // A re-sent part replaces the old row: R2 keeps only the latest bytes for a part number, and so does D1.
  await env.DB.prepare(
    `INSERT INTO parts (attachment_id, n, etag, size) VALUES (?, ?, ?, ?)
     ON CONFLICT (attachment_id, n) DO UPDATE SET etag = excluded.etag, size = excluded.size`,
  )
    .bind(a.id, n, sent.value.etag, expected)
    .run();
  return json({ n, etag: sent.value.etag });
}

const partsOf = async (env: Env, id: string) =>
  (
    await env.DB.prepare("SELECT n, etag, size FROM parts WHERE attachment_id = ? ORDER BY n")
      .bind(id)
      .all<{ n: number; etag: string; size: number }>()
  ).results;

async function listParts(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authorized(req, env, id);
  const uploaded = (await partsOf(env, a.id)).map(({ n, size }) => ({ n, size }));
  return json({ uploaded });
}

async function complete(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authorized(req, env, id);
  // Idempotent: a client retrying after a lost answer gets ok, and no second file_added.
  if (a.status === "complete") return json({ ok: true });
  if (a.status !== "uploading") throw new HttpError(409, "not_uploading");

  const parts = await partsOf(env, a.id);
  const have = new Set(parts.map((p) => p.n));
  const missing: number[] = [];
  for (let n = 1; n <= (a.part_count ?? 0); n++) if (!have.has(n)) missing.push(n);
  if (missing.length > 0) return json({ error: "missing_parts", missing }, 409);

  try {
    await uploadOf(env, a).complete(parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
  } catch (err) {
    if (isNoSuchUpload(err)) {
      // A concurrent complete got there first: its answer stands, ours is the same ok.
      const now = await env.DB.prepare("SELECT status FROM attachments WHERE id = ?").bind(a.id).first<{ status: string }>();
      if (now?.status === "complete") return json({ ok: true });
      // R2 finished an earlier complete whose D1 write failed: the object is there, so the batch below finishes the
      // job. Without this, every retry would ask R2 again and answer 500 forever. No object: aborted, nothing to finish.
      if (now?.status !== "uploading" || (await env.FILES.head(a.r2_key)) === null) throw new HttpError(409, "not_uploading");
    } else if ((await env.FILES.head(a.r2_key)) === null) {
      // R2 refused the part list, most likely an obsolete etag: two PUTs of the same part racing can leave the older
      // one's etag in D1 (its upsert landing last), and the binding has no listParts to learn the newest. The upload
      // is still open and an uploadPart on the same number replaces the bytes, so the way out is to forget what D1
      // knows and ask the client for every part again, instead of a 500 on every retry until the 7-day abort.
      await env.DB.prepare("DELETE FROM parts WHERE attachment_id = ?").bind(a.id).run();
      const missing = Array.from({ length: a.part_count ?? 0 }, (_, i) => i + 1);
      return json({ error: "missing_parts", missing }, 409);
    }
    // Otherwise the object is there: R2 completed despite the error, so the batch below finishes the job. Forgetting
    // the parts in that case would strand the row (every part refused as not_uploading, complete asking for parts).
    // A failing head throws, leaving the parts in place: a 500 the client can retry.
  }
  const at = Date.now();
  const data = JSON.stringify({ attachmentId: a.id, kind: a.kind, size: a.size_bytes });
  // One transaction; the event is written only while the row is still `uploading`, so two racing completes add one
  // file_added between them.
  const [, marked] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO events (report_id, at, type, data) SELECT ?, ?, 'file_added', ? WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ? AND status = 'uploading')",
    ).bind(a.report_id, at, data, a.id),
    env.DB.prepare("UPDATE attachments SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'uploading'").bind(at, a.id),
  ]);
  if (marked!.meta.changes !== 1) {
    // The row left `uploading` under us. A racing complete that wrote it first: the same ok. Anything else (the cron
    // claimed it, a DELETE, the report expired) is about to remove the object, so "ok" would be a lie.
    const now = await env.DB.prepare("SELECT status FROM attachments WHERE id = ?").bind(a.id).first<{ status: string }>();
    if (now?.status !== "complete") throw new HttpError(409, "not_uploading");
  }
  return json({ ok: true });
}

async function remove(req: Request, env: Env, id: string): Promise<Response> {
  let a = await authorized(req, env, id);
  // Two passes at most: if a complete lands between our read and our update, the second pass deletes the object.
  // An upload R2 already completed while D1 says `uploading` is caught by abortUpload, which deletes its object.
  for (let pass = 0; pass < 2; pass++) {
    if (a.status === "uploading") {
      const found = await abortUpload(env.FILES, a.r2_key, a.upload_id ?? "");
      const r = await env.DB.prepare("UPDATE attachments SET status = ? WHERE id = ? AND status = 'uploading'")
        .bind(found ? "deleted" : "aborted", a.id)
        .run();
      if (r.meta.changes === 1) break;
    } else if (a.status === "complete") {
      await env.FILES.delete(a.r2_key);
      await env.DB.prepare("UPDATE attachments SET status = 'deleted' WHERE id = ? AND status = 'complete'").bind(a.id).run();
      break;
    } else break; // aborted or deleted already: nothing left to remove.
    a = (await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(a.id).first<Attachment>()) ?? a;
  }
  return json({ ok: true });
}

const ROUTES: Route[] = [
  {
    method: "POST",
    pattern: new RegExp(`^/reports/(${CODE_PATTERN})/attachments$`),
    handle: (req, env, _c, _u, [code]) => createAttachment(req, env, code!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/attachments/(${ID})/parts/(\\d{1,4})$`),
    handle: (req, env, _c, _u, [id, n]) => putPart(req, env, id!, n!),
  },
  { method: "GET", pattern: new RegExp(`^/attachments/(${ID})/parts$`), handle: (req, env, _c, _u, [id]) => listParts(req, env, id!) },
  {
    method: "POST",
    pattern: new RegExp(`^/attachments/(${ID})/complete$`),
    handle: (req, env, _c, _u, [id]) => complete(req, env, id!),
  },
  { method: "DELETE", pattern: new RegExp(`^/attachments/(${ID})$`), handle: (req, env, _c, _u, [id]) => remove(req, env, id!) },
];

export const handleUploads: RouteHandler = (req, env, ctx, url) => dispatch(ROUTES, req, env, ctx, url);
