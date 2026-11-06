// Shared helpers for the worker specs. They drive the real worker through its exported handler and read D1/R2
// through the same bindings; nothing here re-implements a worker rule.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";
import { TURNSTILE_PASS } from "./outbound";

export { outbound, TURNSTILE_FAIL, TURNSTILE_PASS } from "./outbound";

export const BASE = "https://portal.test/api/v1";
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const handler = worker as ExportedHandler<Cloudflare.Env>;

/**
 * Error codes the specs expect. CONTRACT.md names invalid_what, turnstile_failed, rate_limited, missing_parts,
 * not_found, leased and internal. It does not name the three attachment refusals of acceptance row 9: the names
 * below are the test author's choice and bind the builder.
 */
export const ERRORS = {
  invalidWhat: "invalid_what",
  turnstileFailed: "turnstile_failed",
  rateLimited: "rate_limited",
  missingParts: "missing_parts",
  notFound: "not_found",
  leased: "leased",
  internal: "internal",
  tooManyFiles: "too_many_files",
  fileTooLarge: "file_too_large",
  invalidMime: "invalid_mime",
} as const;

/**
 * Response shapes CONTRACT.md leaves open, chosen here (they bind the builder):
 * - GET /agent/queue answers `{ reports: [{ code, ... }] }`, like GET /game/reports.
 * - POST .../complete with missing parts answers 409 `{ error: "missing_parts", missing: [n, ...] }`; the spec of
 *   row 7 accepts any single array field so only the list itself is binding.
 */
export const SHAPES = { queueListField: "reports" } as const;

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
export const PART_SIZE = 16 * MIB;
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const CODE_RE = /^LUM-\d{6}$/;
export const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export type TestEnv = Cloudflare.Env;
export type Json = Record<string, unknown>;

export async function call(path: string, init: RequestInit = {}, envOverride: Partial<TestEnv> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  // A test request has no edge metadata (`cf`); the cast only satisfies the handler's incoming-request type.
  const req = new Request(url, init) as IncomingRequest;
  const res = await handler.fetch!(req, { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function runCron(envOverride: Partial<TestEnv> = {}): Promise<void> {
  const ctx = createExecutionContext();
  await handler.scheduled!(
    createScheduledController({ cron: "0 3 * * *", scheduledTime: Date.now() }),
    { ...env, ...envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

export async function body<T = Json>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Asserts status and `{error}`; returns the parsed body for further checks. */
export async function expectError(res: Response, status: number, error?: string): Promise<Json> {
  expect(res.status).toBe(status);
  const b = await body(res);
  expect(typeof b.error).toBe("string");
  expect(b.error as string).toMatch(SNAKE_RE);
  if (error !== undefined) expect(b.error).toBe(error);
  return b;
}

let ipCounter = 0;
const ipBase = crypto.getRandomValues(new Uint8Array(2));
/** A fresh client ip per call, so rate limits of one spec never touch another. */
export function nextIp(): string {
  ipCounter += 1;
  return `10.${ipBase[0]}.${(ipBase[1]! + (ipCounter >> 8)) & 0xff}.${ipCounter & 0xff}`;
}

export function uniqueText(label: string): string {
  return `${label} ${crypto.randomUUID()}`;
}

export function jsonInit(method: string, payload: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) };
}

export function agentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${env.AGENT_KEY}`, ...extra };
}

export function gameHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Game-Key": env.GAME_KEY, ...extra };
}

export const devDeskEnv: Partial<TestEnv> = { ENVIRONMENT: "dev", DESK_DEV_BYPASS: "1" };

// ---------- public API helpers ----------

export async function postReport(payload: Json, ip = nextIp(), headers: Record<string, string> = {}): Promise<Response> {
  return call("/reports", jsonInit("POST", payload, { "CF-Connecting-IP": ip, ...headers }));
}

export async function createReport(
  what = uniqueText("A report from the web form"),
  ip = nextIp(),
): Promise<{ code: string; reportToken: string; what: string }> {
  const res = await postReport({ what, turnstileToken: TURNSTILE_PASS }, ip);
  expect(res.status, "creating a report for this spec").toBe(201);
  const b = await body<{ code: string; reportToken: string }>(res);
  return { code: b.code, reportToken: b.reportToken, what };
}

export async function createAttachment(
  code: string,
  token: string,
  file: { filename?: string; size: number; mime?: string },
): Promise<Response> {
  return call(
    `/reports/${code}/attachments`,
    jsonInit(
      "POST",
      { filename: file.filename ?? "clip.mp4", size: file.size, mime: file.mime ?? "video/mp4" },
      { "X-Report-Token": token, "CF-Connecting-IP": nextIp() },
    ),
  );
}

export async function putPart(id: string, n: number, token: string | null, bytes: Uint8Array): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (token !== null) headers["X-Report-Token"] = token;
  return call(`/attachments/${id}/parts/${n}`, { method: "PUT", headers, body: bytes });
}

export async function listParts(id: string, token: string): Promise<Response> {
  return call(`/attachments/${id}/parts`, { method: "GET", headers: { "X-Report-Token": token } });
}

export async function completeUpload(id: string, token: string): Promise<Response> {
  return call(`/attachments/${id}/complete`, { method: "POST", headers: { "X-Report-Token": token } });
}

// ---------- bytes ----------

/** Deterministic bytes of a virtual file `seed`, starting at byte `offset`: any slice can be recomputed. */
export function pattern(seed: number, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let k = 0; k < length; k++) {
    const i = offset + k;
    out[k] = (Math.imul(i, 2654435761) >>> 24) ^ (i >>> 13) ^ seed;
  }
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 of a file made of parts, without holding the whole file twice. */
export async function sha256OfParts(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256Hex(all);
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------- D1 seeding and reads (schema of CONTRACT.md "D1 schema") ----------

export type ReportRow = {
  id: string;
  code: string;
  created_at: number;
  updated_at: number;
  source: string;
  status: string;
  title: string | null;
  what: string;
  where_area: string | null;
  device: string | null;
  lang: string | null;
  roblox_name: string | null;
  roblox_user_id: number | null;
  game_context: string | null;
  report_token_hash: string;
  ip_hash: string | null;
  verdict: string | null;
  triage: string | null;
  duplicate_of: string | null;
  pr_url: string | null;
  lease_until: number | null;
  lease_by: string | null;
};

export type AttachmentRow = {
  id: string;
  report_id: string;
  created_at: number;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  r2_key: string;
  upload_id: string | null;
  part_size: number | null;
  part_count: number | null;
  status: string;
  completed_at: number | null;
};

let codeCounter = 0;
const codeBase = 100_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 800_000);
/** Seeded codes walk from a random base so two spec files rarely meet; the worker's own codes are random too. */
export function seedCode(): string {
  codeCounter += 1;
  return `LUM-${String(codeBase + codeCounter).padStart(6, "0")}`;
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  await env.DB.prepare(sql)
    .bind(...cols.map((c) => row[c] ?? null))
    .run();
}

export async function seedReport(p: Partial<ReportRow> = {}): Promise<ReportRow> {
  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    code: seedCode(),
    created_at: now,
    updated_at: p.created_at ?? now,
    source: "web",
    status: "received",
    what: uniqueText("seeded report"),
    report_token_hash: "0".repeat(64),
    ...p,
  };
  await insert("reports", row);
  return (await reportByCode(row.code))!;
}

export async function seedAttachment(reportId: string, p: Partial<AttachmentRow> = {}): Promise<AttachmentRow> {
  const id = p.id ?? crypto.randomUUID();
  const row = {
    id,
    report_id: reportId,
    created_at: Date.now(),
    kind: "video",
    filename: "clip.mp4",
    mime: "video/mp4",
    size_bytes: 1000,
    r2_key: `spec/${id}`,
    status: "complete",
    ...p,
  };
  await insert("attachments", row);
  return (await attachmentById(id))!;
}

export async function seedEvent(reportId: string, type = "created"): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO events (report_id, at, type, data) VALUES (?, ?, ?, ?) RETURNING seq")
    .bind(reportId, Date.now(), type, "{}")
    .first<{ seq: number }>();
  return r!.seq;
}

export async function reportByCode(code: string): Promise<ReportRow | null> {
  return env.DB.prepare("SELECT * FROM reports WHERE code = ?").bind(code).first<ReportRow>();
}

export async function reportsWithWhatLike(prefix: string): Promise<number> {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM reports WHERE what LIKE ?")
    .bind(`${prefix}%`)
    .first<{ n: number }>();
  return r!.n;
}

export async function attachmentById(id: string): Promise<AttachmentRow | null> {
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();
}

export async function attachmentsOf(reportId: string): Promise<AttachmentRow[]> {
  const r = await env.DB.prepare("SELECT * FROM attachments WHERE report_id = ? ORDER BY created_at")
    .bind(reportId)
    .all<AttachmentRow>();
  return r.results;
}

export async function eventTypesOf(reportId: string): Promise<string[]> {
  const r = await env.DB.prepare("SELECT type FROM events WHERE report_id = ? ORDER BY seq")
    .bind(reportId)
    .all<{ type: string }>();
  return r.results.map((e) => e.type);
}

export async function partRowsOf(attachmentId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM parts WHERE attachment_id = ?")
    .bind(attachmentId)
    .first<{ n: number }>();
  return r!.n;
}
