// The pinned contract (CONTRACT.md "Agent report shape", "Event data", and `expectedStatus` under "Agent and bot") and
// Damian's row 6 of the integration slice:
//   | 6 | Una persona segna `fixed` mentre l'agente manda `looking` | giro | resta `fixed`; l'agente riceve
//   `status_changed` e lo annota |
// Every report, file and event here is made through the worker's own routes; D1 is read only to take a snapshot of
// what a refused write must leave untouched, and to know where the event log stood before a write.
//
// Run by filter: `cd worker && npx vitest run test/contract.spec.ts`.
//
// Mutations (file|old|new|label). The shape specs guard code that exists (green on 9dfbb0a; each mutation was run in a
// throwaway copy and turned its spec red). The compare-and-set specs were red on 9dfbb0a, which has no `expectedStatus`
// at all: that code is their first mutation; the lines below them describe the builder's code, not yet written.
// worker/src/routes/agent.ts|  lease_until, lease_by`;|  lease_until, lease_by, report_token_hash`;|a1 report shape: no hash
// worker/src/routes/agent.ts|game_context: parseStored(row.game_context), |game_context: row.game_context, |a2 game_context parsed
// worker/src/routes/agent.ts|"SELECT id, kind, filename, mime, size_bytes, status, created_at, completed_at FROM|"SELECT id, kind, filename, mime, size_bytes, status, created_at, completed_at, r2_key FROM|a3 attachment keys
// worker/src/routes/agent.ts|json_object('from', status, 'to', ?3, 'note', ?4, 'prUrl', ?5)|json_object('from', status, 'to', ?3, 'note', ?4)|b1 agent status_changed keys
// worker/src/routes/agent.ts|json_object('from', status, 'to', ?) FROM reports WHERE id = ? AND status <> ?|json_object('from', status, 'to', ?, 'note', NULL) FROM reports WHERE id = ? AND status <> ?|b2 triage status_changed keys
// worker/src/routes/desk.ts|'by', 'desk', 'email', ?6)|'by', 'desk')|b3 desk status_changed keys
// worker/src/lib/duplicates.ts|const linked = JSON.stringify({ duplicateOf });|const linked = JSON.stringify({ duplicate_of: duplicateOf });|b4 duplicate_linked key
// worker/src/lib/reports.ts|"created", { source: fields.source }|"created", { source: fields.source, at: now }|b1 created keys
// worker/src/routes/uploads.ts|{ attachmentId: a.id, kind: a.kind, size: a.size_bytes }|{ attachmentId: a.id, kind: a.kind }|b2 file_added keys (upload)
// worker/src/routes/agent.ts|kind: "frames", size: bytes.byteLength|kind: "frame", size: bytes.byteLength|b2 file_added (frames)
// worker/src/routes/agent.ts (builder)|409 status_changed when expectedStatus differs|ignore expectedStatus|c1..c6, d1..d3 (= 9dfbb0a)
// worker/src/routes/agent.ts (builder)|the status condition inside the write (`UPDATE ... WHERE status = ?`)|check with a read before an unconditional write|c7, d4 (race)
// worker/src/lib/duplicates.ts (builder)|the status condition in every statement of the link batch|condition only on the report's UPDATE, or none|c8, d5 (race, duplicate path)
// worker/src/routes/agent.ts (builder)|400 invalid_expected_status for a value outside STATUSES|accept any string|c5
// worker/src/routes/agent.ts (builder)|expectedStatus: null refused on both routes|null counts as absent again (= 312f690)|c5 JSON null, c5b, d3b
// worker/src/routes/agent.ts (builder)|the null check in the status route's reading of expectedStatus|triage only|c5 JSON null, c5b
// worker/src/routes/agent.ts (builder)|the null check in the triage route's reading of expectedStatus|status only|d3b
// worker/src/routes/agent.ts (builder)|null refused, absent passes|absent refused too|c4, d3, and every write that sends no key
// worker/src/routes/agent.ts|'triaged', ? FROM reports WHERE id = ? AND (? IS NULL OR status = ?)|'triaged', ? FROM reports WHERE id = ? AND (? IS NULL OR ? IS NOT NULL)|d4 refused triage writes no triaged event (audit 1 finding 4)
// worker/src/routes/agent.ts|status <> ?\n         AND (? IS NULL OR status = ?)|status <> ?\n         AND (? IS NULL OR ? IS NOT NULL)|d4 refused triage writes no status_changed event (finding 4)
// worker/src/routes/agent.ts|the triage's UPDATE last in its batch|back before the `triaged` event (the guard then sees the new status)|d2 non-duplicate events (finding 3)
// worker/src/lib/duplicates.ts|the report's own UPDATE last in the link batch|back in second place|d2 duplicate events (finding 3)
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  agentHeaders,
  body,
  call,
  CODE_RE,
  completeUpload,
  createAttachment,
  createReport,
  devDeskEnv,
  expectError,
  gameHeaders,
  jsonInit,
  pattern,
  putPart,
  reportByCode,
  seedReport,
  uniqueText,
  type Json,
  type TestEnv,
} from "./helpers";

// CONTRACT.md "Statuses": the internal statuses `expectedStatus` may name.
const STATUSES = ["received", "looking", "fixed", "duplicate", "not_bug", "closed"] as const;
// CONTRACT.md "Agent and bot": the error a bad `expectedStatus` gets (the contract's own pick).
const INVALID_EXPECTED = "invalid_expected_status";

// CONTRACT.md "Agent report shape": every key, no other.
const REPORT_KEYS = [
  "id", "code", "created_at", "updated_at", "source", "status", "title", "what", "where_area", "device", "lang",
  "roblox_name", "roblox_user_id", "discord_user_id", "discord_name", "discord_thread_id", "game_context", "verdict",
  "triage", "duplicate_of", "pr_url", "lease_until", "lease_by", "attachments",
].sort();
const ATTACHMENT_KEYS = ["id", "kind", "filename", "mime", "size_bytes", "status", "created_at", "completed_at"].sort();
const CONTEXT_NUMBERS = ["placeId", "placeVersion", "wave", "fps", "pingMs", "at"];
const CONTEXT_STRINGS = ["jobId", "map", "mode", "platform"];
const NEVER_SENT = ["report_token_hash", "ip_hash", "r2_key", "upload_id", "part_size", "part_count", "report_id"];

type Event = { seq: number; code: string | null; at: number; type: string; data: Json | null };

// ---------- calls ----------

function agentStatus(code: string, payload: Json, envOverride: Partial<TestEnv> = {}): Promise<Response> {
  return call(`/agent/reports/${code}/status`, jsonInit("POST", payload, agentHeaders()), envOverride);
}

function agentTriage(code: string, payload: Json, envOverride: Partial<TestEnv> = {}): Promise<Response> {
  return call(`/agent/reports/${code}/triage`, jsonInit("POST", payload, agentHeaders()), envOverride);
}

function deskStatus(code: string, payload: Json): Promise<Response> {
  return call(`/desk/reports/${code}/status`, jsonInit("POST", payload), devDeskEnv);
}

async function ok(res: Response | Promise<Response>, label: string): Promise<void> {
  const r = await res;
  expect(r.status, `${label}: ${await r.clone().text()}`).toBe(200);
}

function claim(code: string): Promise<Response> {
  return call(`/agent/reports/${code}/claim`, jsonInit("POST", { by: "valor1-agent", minutes: 30 }, agentHeaders()));
}

async function getReport(code: string): Promise<Json> {
  const res = await call(`/agent/reports/${code}`, { headers: agentHeaders() });
  expect(res.status).toBe(200);
  return body(res);
}

let nextUser = 6_100_000 + Math.floor(Math.random() * 1_000_000);
async function gameReport(context: Json = { placeId: 7, wave: 12, map: "Forest", device: "phone", errors: ["e1"] }): Promise<string> {
  nextUser += 1;
  const res = await call(
    "/game/reports",
    jsonInit("POST", { userId: nextUser, userName: "BraveFox", title: "Wave 12 freezes", what: uniqueText("game"), lang: "en", context }, gameHeaders()),
  );
  expect(res.status, "creating a game report").toBe(201);
  return (await body<{ code: string }>(res)).code;
}

let nextSnowflake = 910_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9)) * 1000n;
function snowflake(): string {
  nextSnowflake += 1n;
  return nextSnowflake.toString();
}

async function discordReport(): Promise<string> {
  const res = await call(
    "/agent/reports",
    jsonInit("POST", { source: "discord", discordUserId: snowflake(), discordName: "brave_fox", what: uniqueText("discord") }, agentHeaders()),
  );
  expect(res.status, "creating a discord report").toBe(201);
  return (await body<{ code: string }>(res)).code;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pattern(5, 0, 56)]);
async function postFrame(code: string): Promise<string> {
  const res = await call(`/agent/reports/${code}/frames`, {
    method: "POST",
    headers: agentHeaders({ "Content-Type": "image/png", "X-Filename": "frame-0001.png" }),
    body: PNG,
  });
  expect(res.status, "posting a frame").toBe(201);
  return (await body<{ attachmentId: string }>(res)).attachmentId;
}

/** A player's one-part video, sent and completed through the public upload routes. */
async function uploadVideo(code: string, token: string, size = 1000): Promise<string> {
  const created = await createAttachment(code, token, { size });
  expect(created.status, "creating the attachment").toBe(201);
  const id = (await body<{ attachmentId: string }>(created)).attachmentId;
  expect((await putPart(id, 1, token, pattern(9, 0, size))).status, "sending part 1").toBe(200);
  expect((await completeUpload(id, token)).status, "completing the upload").toBe(200);
  return id;
}

// ---------- events, read the way the bot and the agent read them ----------

async function maxSeq(): Promise<number> {
  return (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS m FROM events").first<{ m: number }>())!.m;
}

/** Every event after `after` from GET /agent/events (all pages), only those of `code`. */
async function eventsOf(code: string, after: number): Promise<Event[]> {
  const out: Event[] = [];
  let cursor = after;
  for (;;) {
    const res = await call(`/agent/events?after=${cursor}&limit=500`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    const page = await body<{ events: Event[]; last: number }>(res);
    out.push(...page.events.filter((e) => e.code === code));
    if (page.events.length === 0) return out;
    cursor = page.last;
  }
}

function keysOf(data: Json | null): string[] {
  expect(data, "event data is an object").not.toBeNull();
  expect(typeof data).toBe("object");
  expect(Array.isArray(data)).toBe(false);
  return Object.keys(data!).sort();
}

function only(events: Event[], type: string): Event {
  const found = events.filter((e) => e.type === type);
  expect(found.map((e) => e.type), `exactly one ${type} event: ${JSON.stringify(events)}`).toEqual([type]);
  return found[0]!;
}

/** Everything a refused write must leave as it was: the whole row and the report's events. */
async function snapshot(code: string): Promise<{ row: unknown; events: Event[] }> {
  return { row: await reportByCode(code), events: await eventsOf(code, 0) };
}

function isInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v);
}

function expectNullOr(v: unknown, check: (x: unknown) => boolean, key: string): void {
  expect(v === null || check(v), `${key} is null or the pinned type: ${JSON.stringify(v)}`).toBe(true);
}

/** The pinned key set and types of "Agent report shape"; nullable keys may be null, never absent. */
function expectReportShape(r: Json): void {
  expect(Object.keys(r).sort()).toEqual(REPORT_KEYS);
  for (const k of NEVER_SENT) expect(r, `${k} is never sent`).not.toHaveProperty(k);
  expect(typeof r.id === "string" && r.id.length > 0).toBe(true);
  expect(r.code).toMatch(CODE_RE);
  expect(isInt(r.created_at) && isInt(r.updated_at)).toBe(true);
  expect(["web", "game", "discord"]).toContain(r.source);
  expect(STATUSES as readonly unknown[]).toContain(r.status);
  expect(typeof r.what).toBe("string");
  for (const k of ["title", "where_area", "device", "lang", "roblox_name", "discord_user_id", "discord_name", "discord_thread_id", "verdict", "duplicate_of", "pr_url", "lease_by"]) {
    expectNullOr(r[k], (x) => typeof x === "string", k);
  }
  expectNullOr(r.roblox_user_id, isInt, "roblox_user_id");
  expectNullOr(r.lease_until, isInt, "lease_until");
  for (const k of ["game_context", "triage"]) {
    expectNullOr(r[k], (x) => typeof x === "object" && !Array.isArray(x), `${k} (parsed, never a JSON string)`);
  }
  expect(Array.isArray(r.attachments)).toBe(true);
  for (const a of r.attachments as Json[]) {
    expect(Object.keys(a).sort()).toEqual(ATTACHMENT_KEYS);
    expect(typeof a.id).toBe("string");
    expect(["video", "image", "frames"]).toContain(a.kind);
    expect(typeof a.filename).toBe("string");
    expect(typeof a.mime).toBe("string");
    expect(isInt(a.size_bytes)).toBe(true);
    expect(["uploading", "complete", "aborted", "deleted"]).toContain(a.status);
    expect(isInt(a.created_at)).toBe(true);
    expectNullOr(a.completed_at, isInt, "completed_at");
    expect(a.completed_at === null).toBe(a.status !== "complete");
  }
}

/**
 * A D1 binding as the real one, except that just before the first write reaches D1 (a `batch`, or `run`/`first`/
 * `all`/`raw` of an INSERT/UPDATE/DELETE statement) it awaits `gap()` once: a person's write landing between whatever
 * the route read and its own write. Implementation-agnostic: a check done by a read before an unconditional write lets
 * the gap's write be overwritten; a condition inside the write does not.
 */
function dbWithGapBeforeFirstWrite(gap: () => Promise<void>): { db: D1Database; fired: () => boolean } {
  let fired = false;
  const real = env.DB;
  const once = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await gap();
  };
  // Proxied statements are handed back to the real batch unwrapped: D1 only accepts its own objects.
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, write: boolean): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), write);
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        const fn = (value as (...a: unknown[]) => unknown).bind(target);
        if (write && (prop === "run" || prop === "first" || prop === "all" || prop === "raw")) {
          return async (...args: unknown[]) => {
            await once();
            return fn(...args);
          };
        }
        return fn;
      },
    });
    unwrap.set(proxy, stmt);
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => wrap(target.prepare(sql), /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await once();
          return target.batch(statements.map((s) => unwrap.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, fired: () => fired };
}

async function expectStatusChanged(res: Response, current: string): Promise<void> {
  expect(res.status, await res.clone().text()).toBe(409);
  expect(await body(res)).toEqual({ error: "status_changed", status: current });
}

// =====================================================================================================================
// (a) GET /agent/reports/{code}: "Agent report shape"
// =====================================================================================================================

describe("contract: GET /agent/reports/{code} answers the pinned flat shape", () => {
  it("a1: a game report, claimed, triaged, threaded, with a PR link and a frame: every pinned key, no other, typed", async () => {
    const code = await gameReport({ placeId: 7, placeVersion: 3, wave: 12, map: "Forest", device: "phone", errors: ["e1"], adminOverride: true });
    await ok(claim(code), "claim");
    const triage = { stage_a: { what: "x" }, stage_b: { summary: "y" }, files: [], notes: [], agent: "lumina-bug-agent/1" };
    await ok(agentTriage(code, { verdict: "needs_person", triage }), "triage");
    const thread = snowflake();
    await ok(call(`/agent/reports/${code}/discord`, jsonInit("POST", { threadId: thread }, agentHeaders())), "thread link");
    await ok(agentStatus(code, { status: "looking", prUrl: "https://github.com/DamianStBeat/Lumina2/pull/9" }), "status");
    const frame = await postFrame(code);

    const r = await getReport(code);

    expectReportShape(r);
    expect(r.code).toBe(code);
    expect(r.source).toBe("game");
    expect(isInt(r.roblox_user_id)).toBe(true);
    expect(typeof r.roblox_name).toBe("string");
    expect(r.discord_thread_id).toBe(thread);
    expect(r.verdict).toBe("needs_person");
    expect(r.triage, "triage is exactly the object posted, parsed").toEqual(triage);
    expect(typeof r.pr_url).toBe("string");
    expect(isInt(r.lease_until) && typeof r.lease_by === "string").toBe(true);
    const ctx = r.game_context as Json;
    expect(typeof ctx === "object" && ctx !== null && !Array.isArray(ctx), "game_context is an object").toBe(true);
    for (const [k, v] of Object.entries(ctx)) {
      if (CONTEXT_NUMBERS.includes(k)) expect(typeof v, k).toBe("number");
      else if (CONTEXT_STRINGS.includes(k)) expect(typeof v, k).toBe("string");
      else if (k === "device") expect(["phone", "tablet", "computer", "console"]).toContain(v);
      else if (k === "errors") expect(Array.isArray(v) && v.every((e) => typeof e === "string")).toBe(true);
      else expect.fail(`game_context carries a key outside the contract: ${k}`);
    }
    const atts = r.attachments as Json[];
    expect(atts.map((a) => a.id)).toEqual([frame]);
    expect(atts[0]!.kind).toBe("frames");
    expect(atts[0]!.size_bytes).toBe(PNG.byteLength);
  });

  it("a2 (not yet): a fresh web report has every key, the unknown ones null (never absent), attachments []", async () => {
    const { code } = await createReport();
    const r = await getReport(code);
    expectReportShape(r);
    for (const k of ["title", "game_context", "triage", "verdict", "duplicate_of", "pr_url", "lease_until", "lease_by", "discord_thread_id", "roblox_user_id"]) {
      expect(r[k], `${k} is null before it exists`).toBeNull();
    }
    expect(r.attachments).toEqual([]);
  });

  it("a3: a discord report, and an upload still running (completed_at null) beside a completed one, in created order", async () => {
    const code = await discordReport();
    let r = await getReport(code);
    expectReportShape(r);
    expect(typeof r.discord_user_id).toBe("string");
    expect(typeof r.discord_name).toBe("string");
    expect(r.roblox_user_id).toBeNull();

    const web = await createReport();
    const done = await uploadVideo(web.code, web.reportToken);
    const running = await createAttachment(web.code, web.reportToken, { size: 2000 });
    expect(running.status).toBe(201);
    const runningId = (await body<{ attachmentId: string }>(running)).attachmentId;
    r = await getReport(web.code);
    expectReportShape(r);
    const atts = r.attachments as Json[];
    expect(atts.map((a) => a.id)).toEqual([done, runningId]);
    expect(atts.map((a) => a.status)).toEqual(["complete", "uploading"]);
    expect(atts[1]!.completed_at).toBeNull();
  });

  it("a4 (missing): an unknown code is 404 not_found", async () => {
    await expectError(await call("/agent/reports/LUM-000000", { headers: agentHeaders() }), 404, "not_found");
  });
});

// =====================================================================================================================
// (b) GET /agent/events: "Event data", one real writer per row of the table
// =====================================================================================================================

describe("contract: event data has exactly the pinned keys, per writer", () => {
  it("b1: created, from each create route: { source }", async () => {
    const before = await maxSeq();
    const web = (await createReport()).code;
    const game = await gameReport();
    const discord = await discordReport();
    for (const [code, source] of [[web, "web"], [game, "game"], [discord, "discord"]] as const) {
      const e = only(await eventsOf(code, before), "created");
      expect(keysOf(e.data)).toEqual(["source"]);
      expect(e.data!.source).toBe(source);
    }
  });

  it("b2: file_added, from a player's completed upload and from the agent's frames: { attachmentId, kind, size }", async () => {
    const web = await createReport();
    const before = await maxSeq();
    const video = await uploadVideo(web.code, web.reportToken, 1234);
    let e = only(await eventsOf(web.code, before), "file_added");
    expect(keysOf(e.data)).toEqual(["attachmentId", "kind", "size"]);
    expect(e.data).toEqual({ attachmentId: video, kind: "video", size: 1234 });
    // A repeated complete adds none.
    expect((await completeUpload(video, web.reportToken)).status).toBe(200);
    expect((await eventsOf(web.code, before)).filter((x) => x.type === "file_added")).toHaveLength(1);

    const mid = await maxSeq();
    const frame = await postFrame(web.code);
    e = only(await eventsOf(web.code, mid), "file_added");
    expect(keysOf(e.data)).toEqual(["attachmentId", "kind", "size"]);
    expect(e.data).toEqual({ attachmentId: frame, kind: "frames", size: PNG.byteLength });
  });

  it("b3: triage (not duplicate): status_changed { from, to } with no note/prUrl, then triaged { verdict }, same at", async () => {
    const { code } = await createReport();
    const before = await maxSeq();
    await ok(agentTriage(code, { verdict: "simple_fix", triage: { s: 1 } }), "triage");
    const events = await eventsOf(code, before);
    expect(events.map((e) => e.type)).toEqual(["status_changed", "triaged"]);
    expect(keysOf(events[0]!.data)).toEqual(["from", "to"]);
    expect(events[0]!.data).toEqual({ from: "received", to: "looking" });
    expect(keysOf(events[1]!.data)).toEqual(["verdict"]);
    expect(events[1]!.data!.verdict).toBe("simple_fix");
    expect(events[1]!.at).toBe(events[0]!.at);

    // Edge: a second triage onto the same status writes triaged only, no status_changed.
    const mid = await maxSeq();
    await ok(agentTriage(code, { verdict: "needs_person", triage: { s: 2 } }), "second triage");
    const again = await eventsOf(code, mid);
    expect(again.map((e) => e.type)).toEqual(["triaged"]);
    expect(again[0]!.data).toEqual({ verdict: "needs_person" });
  });

  it("b4: triage duplicate: status_changed { from, to }, triaged { verdict }, duplicate_linked { duplicateOf } (the root), in that order", async () => {
    const root = (await createReport()).code;
    const middle = (await createReport()).code;
    await ok(agentTriage(middle, { verdict: "duplicate", triage: {}, duplicateOf: root }), "middle -> root");
    const { code } = await createReport();
    const before = await maxSeq();
    await ok(agentTriage(code, { verdict: "duplicate", triage: {}, duplicateOf: middle }), "code -> middle");
    const events = await eventsOf(code, before);
    expect(events.map((e) => e.type)).toEqual(["status_changed", "triaged", "duplicate_linked"]);
    expect(keysOf(events[0]!.data)).toEqual(["from", "to"]);
    expect(events[0]!.data).toEqual({ from: "received", to: "duplicate" });
    expect(events[1]!.data).toEqual({ verdict: "duplicate" });
    expect(keysOf(events[2]!.data)).toEqual(["duplicateOf"]);
    expect(events[2]!.data!.duplicateOf, "the root original, not the code sent").toBe(root);
    expect(new Set(events.map((e) => e.at)).size).toBe(1);
  });

  it("b5: agent status POST: { from, to, note, prUrl }, null when not sent, written also when from equals to", async () => {
    const { code } = await createReport();
    const before = await maxSeq();
    await ok(agentStatus(code, { status: "looking" }), "first");
    await ok(agentStatus(code, { status: "looking", note: "needs_person: risk_path" }), "same status again");
    const events = (await eventsOf(code, before)).filter((e) => e.type === "status_changed");
    expect(events).toHaveLength(2);
    for (const e of events) expect(keysOf(e.data)).toEqual(["from", "note", "prUrl", "to"]);
    expect(events[0]!.data).toEqual({ from: "received", to: "looking", note: null, prUrl: null });
    expect(events[1]!.data).toEqual({ from: "looking", to: "looking", note: "needs_person: risk_path", prUrl: null });
  });

  it("b6: agent status POST duplicate: { from, to, note, prUrl } then duplicate_linked; a report pointing at it is re-pointed", async () => {
    const root = (await createReport()).code;
    const { code } = await createReport();
    const pointer = (await createReport()).code;
    await ok(agentTriage(pointer, { verdict: "duplicate", triage: {}, duplicateOf: code }), "pointer -> code");
    const before = await maxSeq();
    await ok(agentStatus(code, { status: "duplicate", duplicateOf: root }), "code -> root");
    const own = await eventsOf(code, before);
    expect(own.map((e) => e.type)).toEqual(["status_changed", "duplicate_linked"]);
    expect(keysOf(own[0]!.data)).toEqual(["from", "note", "prUrl", "to"]);
    expect(own[0]!.data).toEqual({ from: "received", to: "duplicate", note: null, prUrl: null });
    expect(own[1]!.data).toEqual({ duplicateOf: root });
    const repointed = await eventsOf(pointer, before);
    expect(repointed.map((e) => e.type), "re-pointed: duplicate_linked only").toEqual(["duplicate_linked"]);
    expect(keysOf(repointed[0]!.data)).toEqual(["duplicateOf"]);
    expect(repointed[0]!.data!.duplicateOf).toBe(root);
  });

  it("b7: desk status POST: { from, to, note, prUrl, by: 'desk', email } (email null on the dev bypass), also from equals to", async () => {
    const { code } = await createReport();
    const before = await maxSeq();
    await ok(deskStatus(code, { status: "fixed", note: "Shipped." }), "desk fixed");
    await ok(deskStatus(code, { status: "fixed" }), "desk fixed again");
    const events = (await eventsOf(code, before)).filter((e) => e.type === "status_changed");
    expect(events).toHaveLength(2);
    for (const e of events) expect(keysOf(e.data)).toEqual(["by", "email", "from", "note", "prUrl", "to"]);
    expect(events[0]!.data).toEqual({ from: "received", to: "fixed", note: "Shipped.", prUrl: null, by: "desk", email: null });
    expect(events[1]!.data).toEqual({ from: "fixed", to: "fixed", note: null, prUrl: null, by: "desk", email: null });

    const original = (await createReport()).code;
    const mid = await maxSeq();
    await ok(deskStatus(code, { status: "duplicate", duplicateOf: original }), "desk duplicate");
    const dup = await eventsOf(code, mid);
    expect(dup.map((e) => e.type)).toEqual(["status_changed", "duplicate_linked"]);
    expect(keysOf(dup[0]!.data)).toEqual(["by", "email", "from", "note", "prUrl", "to"]);
    expect(dup[0]!.data).toMatchObject({ from: "fixed", to: "duplicate", by: "desk" });
    expect(dup[1]!.data).toEqual({ duplicateOf: original });
  });
});

// =====================================================================================================================
// (c) POST /agent/reports/{code}/status with expectedStatus (compare-and-set), row 6
// =====================================================================================================================

describe("contract: status POST compare-and-set (expectedStatus)", () => {
  it("c1 row 6: the desk marks fixed, then the agent's looking with expectedStatus looking -> 409 status_changed fixed, stays fixed", async () => {
    const { code } = await createReport();
    await ok(agentTriage(code, { verdict: "simple_fix", triage: {} }), "triage -> looking");
    await ok(deskStatus(code, { status: "fixed", note: "Shipped." }), "desk fixed");
    const before = await snapshot(code);

    const res = await agentStatus(code, { status: "looking", note: "needs_person: redteam_fix", expectedStatus: "looking" });

    await expectStatusChanged(res, "fixed");
    expect(await snapshot(code), "nothing written: no column, no event").toEqual(before);
    const pub = await body<{ status: string }>(await call(`/status/${code}`, { method: "GET" }));
    expect(pub.status, "the player still sees fixed").toBe("fixed");
  });

  it.each(STATUSES)("c2: expectedStatus %s matching the stored status -> 200, written, one status_changed", async (current) => {
    const original = (await createReport()).code;
    const r = await seedReport(current === "duplicate" ? { status: "duplicate", duplicate_of: original } : { status: current });
    const before = await maxSeq();
    const res = await agentStatus(r.code, { status: "looking", prUrl: "https://github.com/DamianStBeat/Lumina2/pull/5", expectedStatus: current });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await reportByCode(r.code);
    expect(row!.status).toBe("looking");
    expect(row!.pr_url).toBe("https://github.com/DamianStBeat/Lumina2/pull/5");
    expect(row!.duplicate_of).toBeNull();
    const e = only(await eventsOf(r.code, before), "status_changed");
    expect(e.data).toMatchObject({ from: current, to: "looking" });
  });

  it("c3: a different expectedStatus -> 409 with the current status; status, pr_url, duplicate_of untouched, no event", async () => {
    const original = (await createReport()).code;
    const { code } = await createReport();
    await ok(agentStatus(code, { status: "looking", prUrl: "https://github.com/DamianStBeat/Lumina2/pull/1" }), "pr link");
    await ok(agentStatus(code, { status: "duplicate", duplicateOf: original }), "linked");
    const before = await snapshot(code);
    expect((before.row as { duplicate_of: string }).duplicate_of, "scenario: a link and a PR to lose").toBe(original);

    for (const payload of [
      { status: "fixed", prUrl: "https://github.com/DamianStBeat/Lumina2/pull/2", expectedStatus: "looking" },
      { status: "looking", note: "n", expectedStatus: "received" },
      { status: "duplicate", duplicateOf: (await createReport()).code, expectedStatus: "fixed" },
    ]) {
      await expectStatusChanged(await agentStatus(code, payload), "duplicate");
      expect(await snapshot(code), `nothing written for ${JSON.stringify(payload)}`).toEqual(before);
    }
  });

  it("c4 (absent): no expectedStatus keeps today's behaviour: the agent's looking lands on a fixed report", async () => {
    const { code } = await createReport();
    await ok(deskStatus(code, { status: "fixed" }), "desk fixed");
    await ok(agentStatus(code, { status: "looking" }), "status without expectedStatus");
    expect((await reportByCode(code))!.status).toBe("looking");
  });

  it.each([
    ["a public status", "checked"],
    ["another case", "Fixed"],
    ["an empty string", ""],
    ["a number", 3],
    ["an object", { status: "fixed" }],
    // Reverses "null counts as absent" (brief 5a, decision 1): a null would switch off the compare-and-set.
    ["JSON null", null],
  ])("c5: expectedStatus %s -> 400 invalid_expected_status, nothing written", async (_label, value) => {
    const { code } = await createReport();
    const before = await snapshot(code);
    await expectError(await agentStatus(code, { status: "looking", expectedStatus: value }), 400, INVALID_EXPECTED);
    expect(await snapshot(code)).toEqual(before);
  });

  it("c5b (Astra, agent.ts:49): a person's fixed report, the agent's write with expectedStatus null -> 400, it stays fixed, nothing written (plain status and duplicate link)", async () => {
    const { code } = await createReport();
    await ok(deskStatus(code, { status: "fixed", prUrl: "https://github.com/DamianStBeat/Lumina2/pull/9" }), "desk fixed");
    const before = await snapshot(code);
    const writes: Json[] = [
      { status: "looking", note: "needs_person: x", expectedStatus: null },
      { status: "duplicate", duplicateOf: (await createReport()).code, expectedStatus: null },
    ];
    for (const write of writes) {
      await expectError(await agentStatus(code, write), 400, INVALID_EXPECTED);
      expect(await snapshot(code)).toEqual(before);
    }
  });

  it("c6 (missing): an unknown code with expectedStatus is 404 not_found, not 409", async () => {
    await expectError(await agentStatus("LUM-000000", { status: "looking", expectedStatus: "looking" }), 404, "not_found");
  });

  it("c7 (race): the desk's fixed landing between the route's read and its write -> 409, the desk's fixed stays", async () => {
    const { code } = await createReport();
    await ok(agentTriage(code, { verdict: "simple_fix", triage: {} }), "triage -> looking");
    const gap = dbWithGapBeforeFirstWrite(async () => {
      await ok(deskStatus(code, { status: "fixed", note: "Shipped." }), "desk fixed in the gap");
    });

    const res = await agentStatus(code, { status: "looking", note: "needs_person: x", expectedStatus: "looking" }, { DB: gap.db });

    expect(gap.fired(), "the gap ran before the agent's write").toBe(true);
    await expectStatusChanged(res, "fixed");
    expect((await reportByCode(code))!.status).toBe("fixed");
    const last = (await eventsOf(code, 0)).filter((e) => e.type === "status_changed").at(-1)!;
    expect(last.data, "the last status_changed is the desk's").toMatchObject({ to: "fixed", by: "desk" });
  });

  it("c8 (race, duplicate path): the desk's fixed in the gap -> 409, no link, no duplicate_linked", async () => {
    const original = (await createReport()).code;
    const { code } = await createReport();
    await ok(agentTriage(code, { verdict: "needs_person", triage: {} }), "triage -> looking");
    const gap = dbWithGapBeforeFirstWrite(async () => {
      await ok(deskStatus(code, { status: "fixed" }), "desk fixed in the gap");
    });
    const before = await maxSeq();

    const res = await agentStatus(code, { status: "duplicate", duplicateOf: original, expectedStatus: "looking" }, { DB: gap.db });

    expect(gap.fired()).toBe(true);
    await expectStatusChanged(res, "fixed");
    const row = await reportByCode(code);
    expect(row!.status).toBe("fixed");
    expect(row!.duplicate_of).toBeNull();
    expect((await eventsOf(code, before)).map((e) => e.type), "only the desk's event").toEqual(["status_changed"]);
  });

  it("c9: the desk route ignores expectedStatus (a person always wins), a bad value included", async () => {
    const { code } = await createReport();
    await ok(deskStatus(code, { status: "fixed", expectedStatus: "looking" }), "desk with a stale expectedStatus");
    expect((await reportByCode(code))!.status).toBe("fixed");
    await ok(deskStatus(code, { status: "closed", expectedStatus: "bogus" }), "desk with a bad expectedStatus");
    expect((await reportByCode(code))!.status).toBe("closed");
  });
});

// =====================================================================================================================
// (d) POST /agent/reports/{code}/triage with expectedStatus
// =====================================================================================================================

describe("contract: triage POST compare-and-set (expectedStatus)", () => {
  it("d1: claimed, then the desk sets fixed, then triage with expectedStatus received -> 409 fixed; verdict and triage not written", async () => {
    const { code } = await createReport();
    await ok(claim(code), "claim");
    await ok(deskStatus(code, { status: "fixed" }), "desk fixed");
    const before = await snapshot(code);

    for (const payload of [
      { verdict: "needs_person", triage: { s: 1 }, expectedStatus: "received" },
      { verdict: "duplicate", triage: { s: 1 }, duplicateOf: (await createReport()).code, expectedStatus: "received" },
      { verdict: "not_bug", triage: { s: 1 }, expectedStatus: "looking" },
    ]) {
      await expectStatusChanged(await agentTriage(code, payload), "fixed");
      expect(await snapshot(code), `nothing written for ${payload.verdict}`).toEqual(before);
    }
    const row = await reportByCode(code);
    expect(row!.verdict).toBeNull();
    expect(row!.triage).toBeNull();
    expect(row!.duplicate_of).toBeNull();
  });

  it("d2: expectedStatus received matching -> 200, written as today, and every event in the pinned order (non-duplicate and duplicate)", async () => {
    const { code } = await createReport();
    await ok(agentTriage(code, { verdict: "simple_fix", triage: { s: 1 }, expectedStatus: "received" }), "triage");
    let row = await reportByCode(code);
    expect([row!.status, row!.verdict]).toEqual(["looking", "simple_fix"]);
    const events = await eventsOf(code, 0);
    // CONTRACT.md "Event data": within one write status_changed, then triaged, then duplicate_linked, all with one `at`.
    expect(events.map((e) => e.type), "the agent's triage keeps its events").toEqual(["created", "status_changed", "triaged"]);
    expect(events[1]!.data).toEqual({ from: "received", to: "looking" });
    expect(events[2]!.data).toEqual({ verdict: "simple_fix" });
    expect(events[2]!.at).toBe(events[1]!.at);

    const original = (await createReport()).code;
    const dup = (await createReport()).code;
    await ok(agentTriage(dup, { verdict: "duplicate", triage: {}, duplicateOf: original, expectedStatus: "received" }), "dup triage");
    row = await reportByCode(dup);
    expect([row!.status, row!.duplicate_of]).toEqual(["duplicate", original]);
    const dupEvents = await eventsOf(dup, 0);
    expect(dupEvents.map((e) => e.type), "the duplicate keeps triaged and duplicate_linked").toEqual([
      "created",
      "status_changed",
      "triaged",
      "duplicate_linked",
    ]);
    expect(dupEvents[1]!.data).toEqual({ from: "received", to: "duplicate" });
    expect(dupEvents[2]!.data).toEqual({ verdict: "duplicate" });
    expect(dupEvents[3]!.data).toEqual({ duplicateOf: original });
    expect(new Set(dupEvents.slice(1).map((e) => e.at)).size, "one write, one `at`").toBe(1);
  });

  it("d3: a bad expectedStatus -> 400 invalid_expected_status; absent -> today's behaviour onto a fixed report", async () => {
    const { code } = await createReport();
    const before = await snapshot(code);
    await expectError(await agentTriage(code, { verdict: "needs_person", triage: {}, expectedStatus: "checked" }), 400, INVALID_EXPECTED);
    expect(await snapshot(code)).toEqual(before);

    await ok(deskStatus(code, { status: "fixed" }), "desk fixed");
    await ok(agentTriage(code, { verdict: "needs_person", triage: {} }), "triage without expectedStatus");
    expect((await reportByCode(code))!.status).toBe("looking");
  });

  it("d3b (Astra, agent.ts:49): expectedStatus null on triage -> 400 invalid_expected_status, nothing written, on a new report and on a person's fixed one (plain verdict and duplicate link)", async () => {
    const fresh = await createReport();
    const fixed = await createReport();
    await ok(deskStatus(fixed.code, { status: "fixed" }), "desk fixed");
    for (const { code } of [fresh, fixed]) {
      const before = await snapshot(code);
      const writes: Json[] = [
        { verdict: "needs_person", triage: { s: 1 }, expectedStatus: null },
        { verdict: "duplicate", triage: { s: 1 }, duplicateOf: (await createReport()).code, expectedStatus: null },
      ];
      for (const write of writes) {
        await expectError(await agentTriage(code, write), 400, INVALID_EXPECTED);
        expect(await snapshot(code)).toEqual(before);
      }
    }
  });

  it("d4 (race): the desk's fixed between the triage's read and its write -> 409, verdict not written, no event of the refused write", async () => {
    const { code } = await createReport();
    await ok(claim(code), "claim");
    const gap = dbWithGapBeforeFirstWrite(async () => {
      await ok(deskStatus(code, { status: "fixed" }), "desk fixed in the gap");
    });
    const before = await maxSeq();
    const res = await agentTriage(code, { verdict: "simple_fix", triage: { s: 1 }, expectedStatus: "received" }, { DB: gap.db });
    expect(gap.fired()).toBe(true);
    await expectStatusChanged(res, "fixed");
    const row = await reportByCode(code);
    expect([row!.status, row!.verdict, row!.triage]).toEqual(["fixed", null, null]);
    // CONTRACT.md: a refused write leaves "no column, no event"; the one event left is the desk's.
    const events = await eventsOf(code, before);
    expect(events.map((e) => e.type), "only the desk's event").toEqual(["status_changed"]);
    expect(events[0]!.data).toMatchObject({ to: "fixed", by: "desk" });
  });

  it("d5 (race, duplicate path): the desk's fixed in the gap -> 409, no link, no triaged or duplicate_linked event", async () => {
    const original = (await createReport()).code;
    const { code } = await createReport();
    await ok(claim(code), "claim");
    const gap = dbWithGapBeforeFirstWrite(async () => {
      await ok(deskStatus(code, { status: "fixed" }), "desk fixed in the gap");
    });
    const before = await maxSeq();
    const res = await agentTriage(code, { verdict: "duplicate", triage: {}, duplicateOf: original, expectedStatus: "received" }, { DB: gap.db });
    expect(gap.fired()).toBe(true);
    await expectStatusChanged(res, "fixed");
    const row = await reportByCode(code);
    expect([row!.status, row!.verdict, row!.duplicate_of]).toEqual(["fixed", null, null]);
    expect((await eventsOf(code, before)).map((e) => e.type)).toEqual(["status_changed"]);
  });
});
