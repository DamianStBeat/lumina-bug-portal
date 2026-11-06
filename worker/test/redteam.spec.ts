// Specs for the red team findings of round 1 (redteam-astra.md, redteam-opus.md) and the lead's fix decisions 1-7
// (brief-fix-rt.md), then of round 2 (redteam-astra-2.md, redteam-opus-2.md, brief-fix-rt2.md), named `redteam-2:`, then of
// round 3 (redteam-astra-3.md: concurrent duplicate cycles, events for re-pointed links), named `redteam-3:`.
// CONTRACT.md "Limits" (rate, retention), "Statuses", "Game", "Agent and bot", "Desk".
//
// Races are made deterministic with binding doubles passed as env overrides: a D1 or R2 binding that forwards every
// call to the real one and, once, runs another real request in the gap the finding names (between a route's read
// and its write, or between the cron's listing and its delete). Nothing here re-implements a worker rule.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  agentHeaders,
  attachmentById,
  body,
  call,
  completeUpload,
  createAttachment,
  createReport,
  DAY,
  devDeskEnv,
  ERRORS,
  eventTypesOf,
  expectError,
  gameHeaders,
  jsonInit,
  listParts,
  nextIp,
  PART_SIZE,
  pattern,
  putPart,
  reportByCode,
  runCron,
  seedAttachment,
  seedCode,
  seedReport,
  sha256Hex,
  sha256OfParts,
  TURNSTILE_PASS,
  uniqueText,
  type ReportRow,
  type TestEnv,
} from "./helpers";

const HOUR = 3_600_000;
// Most cron runs a 12-month report may need before it is fully gone (lead's decision 1: "after a few runs").
const MAX_CRON_RUNS = 3;

/**
 * Freezes the clock in the middle of the current hour while `fn` runs, so a count of six requests can never straddle
 * an hourly rate window (the windows are fixed hours, CONTRACT.md "Limits" > Rate). Only Date is faked.
 */
async function inOneRateWindow(fn: () => Promise<void>): Promise<void> {
  const mid = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(mid);
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

type EventRow = { type: string; data: Record<string, unknown> | null };

async function eventsOf(reportId: string): Promise<EventRow[]> {
  const r = await env.DB.prepare("SELECT type, data FROM events WHERE report_id = ? ORDER BY seq")
    .bind(reportId)
    .all<{ type: string; data: string | null }>();
  return r.results.map((e) => ({ type: e.type, data: e.data === null ? null : (JSON.parse(e.data) as Record<string, unknown>) }));
}

async function statusChanges(reportId: string): Promise<Record<string, unknown>[]> {
  return (await eventsOf(reportId)).filter((e) => e.type === "status_changed").map((e) => e.data ?? {});
}

/**
 * A D1 binding that behaves as the real one, except that the first `batch` call first awaits `gap()`: another writer
 * landing between a route's read and its batched write.
 */
function dbWithGapBeforeFirstBatch(gap: () => Promise<void>): { db: D1Database; fired: () => boolean } {
  let fired = false;
  const real = env.DB;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await gap();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, fired: () => fired };
}

/** An R2 binding as the real one, except that the first `delete` touching `key` first awaits `gap()`. */
function filesWithGapBeforeDeleteOf(key: string, gap: () => Promise<void>): { files: R2Bucket; fired: () => boolean } {
  let fired = false;
  const real = env.FILES;
  const files = new Proxy(real, {
    get(target, prop) {
      if (prop === "delete") {
        return async (keys: string | string[]) => {
          const touches = Array.isArray(keys) ? keys.includes(key) : keys === key;
          if (touches && !fired) {
            fired = true;
            await gap();
          }
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { files, fired: () => fired };
}

function deskStatus(code: string, payload: Record<string, unknown>): Promise<Response> {
  return call(`/desk/reports/${code}/status`, jsonInit("POST", payload), devDeskEnv);
}

function agentStatus(code: string, payload: Record<string, unknown>, envOverride: Partial<TestEnv> = {}): Promise<Response> {
  return call(`/agent/reports/${code}/status`, jsonInit("POST", payload, agentHeaders()), envOverride);
}

function triage(code: string, payload: Record<string, unknown>, envOverride: Partial<TestEnv> = {}): Promise<Response> {
  return call(`/agent/reports/${code}/triage`, jsonInit("POST", payload, agentHeaders()), envOverride);
}

function linkDuplicate(code: string, original: string): Promise<Response> {
  return triage(code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: original });
}

async function publicStatus(code: string): Promise<string> {
  const res = await call(`/status/${code}`, { method: "GET" });
  expect(res.status).toBe(200);
  return (await body<{ status: string }>(res)).status;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pattern(3, 0, 56)]);

function postFrame(code: string, bytes: Uint8Array = PNG, mime = "image/png"): Promise<Response> {
  return call(`/agent/reports/${code}/frames`, {
    method: "POST",
    headers: agentHeaders({ "Content-Type": mime, "X-Filename": "frame-0001.png" }),
    body: bytes,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Opus TEST-GAP game.ts:30 / agent.ts:226 / public.ts:45: the three rate limits of CONTRACT.md "Limits" > Rate.
// ---------------------------------------------------------------------------------------------------------------

let nextRobloxUser = 8_000_000 + Math.floor(Math.random() * 1_000_000);
function robloxUser(): number {
  nextRobloxUser += 1;
  return nextRobloxUser;
}

function postGame(userId: number, what = uniqueText("redteam game")): Promise<Response> {
  return call(
    "/game/reports",
    jsonInit("POST", { userId, userName: "BraveFox", title: "Wave freezes", what, lang: "en", context: {} }, gameHeaders()),
  );
}

let nextSnowflake = 900_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9)) * 1000n;
function snowflake(): string {
  nextSnowflake += 1n;
  return nextSnowflake.toString();
}

function postDiscord(discordUserId: string, what = uniqueText("redteam discord")): Promise<Response> {
  return call(
    "/agent/reports",
    jsonInit("POST", { source: "discord", discordUserId, discordName: "brave_fox", what }, agentHeaders()),
  );
}

function attachSession(code: string, ip: string): Promise<Response> {
  return call(`/reports/${code}/attach-session`, jsonInit("POST", { turnstileToken: TURNSTILE_PASS }, { "CF-Connecting-IP": ip }));
}

describe("redteam: rate limits", () => {
  it("redteam: game create, the sixth report in one hour for the same roblox_user_id gets 429 rate_limited; another user still 201", async () => {
    await inOneRateWindow(async () => {
      const user = robloxUser();
      for (let i = 1; i <= 5; i++) expect((await postGame(user)).status, `game report #${i} of 5`).toBe(201);
      await expectError(await postGame(user), 429, ERRORS.rateLimited);
      expect((await postGame(robloxUser())).status).toBe(201);
    });
  });

  it("redteam: discord create, the sixth report in one hour for the same discordUserId gets 429 rate_limited; another user still 201", async () => {
    await inOneRateWindow(async () => {
      const user = snowflake();
      for (let i = 1; i <= 5; i++) expect((await postDiscord(user)).status, `discord report #${i} of 5`).toBe(201);
      await expectError(await postDiscord(user), 429, ERRORS.rateLimited);
      expect((await postDiscord(snowflake())).status).toBe(201);
    });
  });

  it("redteam: attach-session, the eleventh session in one hour from the same ip gets 429 rate_limited; another ip still 200", async () => {
    const report = await createReport();
    await inOneRateWindow(async () => {
      const ip = nextIp();
      for (let i = 1; i <= 10; i++) expect((await attachSession(report.code, ip)).status, `attach-session #${i} of 10`).toBe(200);
      await expectError(await attachSession(report.code, ip), 429, ERRORS.rateLimited);
      expect((await attachSession(report.code, nextIp())).status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Opus TEST-GAP agent.ts:199 / desk.ts:161 and REUSE desk.ts:154: the two status routes and one prUrl rule.
// ---------------------------------------------------------------------------------------------------------------

const VALID_PR = "https://github.com/o/r/pull/12";
const statusRoutes: [string, (code: string, payload: Record<string, unknown>) => Promise<Response>][] = [
  ["agent", (code, payload) => agentStatus(code, payload)],
  ["desk", deskStatus],
];

describe("redteam: POST /agent|desk/reports/{code}/status", () => {
  it.each(statusRoutes)("redteam: %s status change stores status and pr_url and appends one status_changed looking -> fixed", async (_route, post) => {
    const r = await seedReport({ status: "looking" });

    const res = await post(r.code, { status: "fixed", prUrl: VALID_PR, note: "fix is live" });

    expect(res.status).toBe(200);
    const row = await reportByCode(r.code);
    expect(row!.status).toBe("fixed");
    expect(row!.pr_url).toBe(VALID_PR);
    const changes = await statusChanges(r.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBe("looking");
    expect(changes[0]!.to).toBe("fixed");
  });

  it.each(statusRoutes)("redteam: %s status change without prUrl keeps the stored pr_url (absent is not a clear)", async (_route, post) => {
    const r = await seedReport({ status: "looking", pr_url: VALID_PR });
    expect((await post(r.code, { status: "fixed" })).status).toBe(200);
    const row = await reportByCode(r.code);
    expect(row!.status).toBe("fixed");
    expect(row!.pr_url).toBe(VALID_PR);
  });

  const badUrls: [string, string][] = [
    ["no path", "https://github.com"],
    ["a space in the path", "https://github.com/a b"],
    ["a repository, not a pull request", "https://github.com/o/r"],
    ["an issue, not a pull request", "https://github.com/o/r/issues/12"],
    ["another host", "https://gitlab.com/o/r/pull/12"],
    ["over 300 characters", `https://github.com/o/r/pull/${"1".repeat(300 - "https://github.com/o/r/pull/".length + 1)}`],
  ];
  const badCases = statusRoutes.flatMap(([route, post]) => badUrls.map(([label, url]) => [route, label, url, post] as const));

  it.each(badCases)("redteam: %s prUrl with %s (%s) is 400 invalid_pr_url and changes nothing", async (_route, _label, url, post) => {
    const r = await seedReport({ status: "looking" });
    await expectError(await post(r.code, { status: "fixed", prUrl: url }), 400, "invalid_pr_url");
    const row = await reportByCode(r.code);
    expect(row!.status).toBe("looking");
    expect(row!.pr_url).toBeNull();
    expect(await statusChanges(r.id)).toEqual([]);
  });

  it.each(statusRoutes)("redteam: %s prUrl https://github.com/o/r/pull/12 is accepted", async (_route, post) => {
    const r = await seedReport({ status: "looking" });
    expect((await post(r.code, { status: "fixed", prUrl: VALID_PR })).status).toBe(200);
    expect((await reportByCode(r.code))!.pr_url).toBe(VALID_PR);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Opus TEST-GAP game.ts:37: GET /game/reports?userId= (last 10, newest first, public statuses only).
// ---------------------------------------------------------------------------------------------------------------

describe("redteam: GET /game/reports", () => {
  type Listed = { code: string; title: string | null; status: string; updatedAt: number };

  async function list(query: string): Promise<Response> {
    return call(`/game/reports${query}`, { headers: gameHeaders() });
  }

  it("redteam: only that user's reports, at most 10, newest first, internal statuses shown as public ones", async () => {
    const user = robloxUser();
    const base = Date.now() - 100 * 60_000;
    const origFixed = await seedReport({ status: "fixed" });
    const origClosed = await seedReport({ status: "closed" });
    const origLooking = await seedReport({ status: "looking" });
    // [internal status, duplicate_of, public status the player must see] from oldest to newest (CONTRACT.md "Statuses").
    const plan: [string, string | null, string][] = [
      ["received", null, "received"],
      ["fixed", null, "fixed"],
      ["received", null, "received"],
      ["looking", null, "looking"],
      ["fixed", null, "fixed"],
      ["not_bug", null, "checked"],
      ["closed", null, "checked"],
      ["duplicate", origFixed.code, "fixed"],
      ["duplicate", origClosed.code, "checked"],
      ["duplicate", origLooking.code, "looking"],
      ["received", null, "received"],
      ["not_bug", null, "checked"],
    ];
    const seeded: { row: ReportRow; shown: string }[] = [];
    for (const [i, [status, dup, shown]] of plan.entries()) {
      const row = await seedReport({
        source: "game",
        roblox_user_id: user,
        title: `report ${i}`,
        status,
        duplicate_of: dup,
        created_at: base + i * 1_000,
      });
      seeded.push({ row, shown });
    }
    // Another player's report, newer than all of them: never in this user's list.
    const stranger = await seedReport({ source: "game", roblox_user_id: robloxUser(), status: "received", created_at: base + 60_000 });

    const res = await list(`?userId=${user}`);

    expect(res.status).toBe(200);
    const { reports } = await body<{ reports: Listed[] }>(res);
    const expected = seeded.slice(-10).reverse();
    expect(reports.map((r) => r.code)).toEqual(expected.map((s) => s.row.code));
    expect(reports.map((r) => r.status)).toEqual(expected.map((s) => s.shown));
    expect(reports.map((r) => r.title)).toEqual(expected.map((s) => s.row.title));
    expect(reports.map((r) => r.code)).not.toContain(stranger.code);
    for (const r of reports) expect(["received", "looking", "fixed", "checked"]).toContain(r.status);
  });

  it("redteam (edge): a user with no reports gets an empty list, not an error", async () => {
    const res = await list(`?userId=${robloxUser()}`);
    expect(res.status).toBe(200);
    expect((await body<{ reports: Listed[] }>(res)).reports).toEqual([]);
  });

  it("redteam (missing): no userId is a 400, never every player's reports", async () => {
    const res = await list("");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Astra CONCEPT status.ts:20 and decision 4: duplicate chains and cycles.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam: duplicate chains", () => {
  /** An original with `status`, then `links` reports each triaged as a duplicate of the one before. */
  async function chainThroughTriage(links: number, status: string): Promise<{ original: ReportRow; chain: ReportRow[] }> {
    const original = await seedReport({ status });
    const chain: ReportRow[] = [];
    let previous = original.code;
    for (let i = 0; i < links; i++) {
      const r = await seedReport();
      expect((await linkDuplicate(r.code, previous)).status, `link #${i + 1}`).toBe(200);
      chain.push(r);
      previous = r.code;
    }
    return { original, chain };
  }

  it("redteam: six duplicate links made by triage, ending at a fixed report, show fixed on the last one", async () => {
    const { chain } = await chainThroughTriage(6, "fixed");
    expect(await publicStatus(chain.at(-1)!.code)).toBe("fixed");
  });

  it("redteam (edge): five duplicate links ending at a fixed report show fixed", async () => {
    const { chain } = await chainThroughTriage(5, "fixed");
    expect(await publicStatus(chain.at(-1)!.code)).toBe("fixed");
  });

  it("redteam: triage of a duplicate of a duplicate stores the root original (decision 4)", async () => {
    const { original, chain } = await chainThroughTriage(3, "looking");
    for (const r of chain) expect((await reportByCode(r.code))!.duplicate_of).toBe(original.code);
  });

  it("redteam: a link that would close a two-report cycle is 409 duplicate_cycle and changes nothing", async () => {
    const a = await seedReport();
    const b = await seedReport({ status: "looking" });
    expect((await linkDuplicate(a.code, b.code)).status).toBe(200);
    const before = await eventTypesOf(b.id);

    await expectError(await linkDuplicate(b.code, a.code), 409, "duplicate_cycle");

    const row = await reportByCode(b.code);
    expect(row!.status).toBe("looking");
    expect(row!.duplicate_of).toBeNull();
    expect(row!.verdict).toBeNull();
    expect(await eventTypesOf(b.id)).toEqual(before);
  });

  it("redteam: a link that would close a three-report cycle is 409 duplicate_cycle", async () => {
    const a = await seedReport();
    const b = await seedReport();
    const c = await seedReport({ status: "looking" });
    expect((await linkDuplicate(a.code, b.code)).status).toBe(200);
    expect((await linkDuplicate(b.code, c.code)).status).toBe(200);
    await expectError(await linkDuplicate(c.code, a.code), 409, "duplicate_cycle");
    expect((await reportByCode(c.code))!.duplicate_of).toBeNull();
  });

  /** Old data written before decision 4: a chain stored link by link, `links` hops from the last to the original. */
  async function storedChain(links: number, status: string): Promise<ReportRow> {
    let previous = (await seedReport({ status })).code;
    let last: ReportRow | null = null;
    for (let i = 0; i < links; i++) {
      last = await seedReport({ status: "duplicate", duplicate_of: previous });
      previous = last.code;
    }
    return last!;
  }

  it("redteam: an old stored chain of seven links still resolves to the original's fixed (read guard raised to 10)", async () => {
    expect(await publicStatus((await storedChain(7, "fixed")).code)).toBe("fixed");
  });

  it("redteam (edge): an old stored chain of twelve links stops at the guard and shows checked", async () => {
    expect(await publicStatus((await storedChain(12, "fixed")).code)).toBe("checked");
  });

  it("redteam (edge): an old stored loop A -> B -> A answers checked instead of hanging", async () => {
    const a = await seedReport({ status: "duplicate" });
    const b = await seedReport({ status: "duplicate", duplicate_of: a.code });
    await env.DB.prepare("UPDATE reports SET duplicate_of = ? WHERE id = ?").bind(b.code, a.id).run();
    expect(await publicStatus(a.code)).toBe("checked");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Astra CONCEPT agent.ts:137 and decision 5: a frame upload is a file_added event.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam: POST /agent/reports/{code}/frames", () => {
  it("redteam: a frame upload appends exactly one file_added event with its attachment id, kind frames and size", async () => {
    const r = await seedReport();

    const res = await postFrame(r.code);

    expect(res.status).toBe(201);
    const { attachmentId } = await body<{ attachmentId: string }>(res);
    const added = (await eventsOf(r.id)).filter((e) => e.type === "file_added");
    expect(added).toHaveLength(1);
    expect(added[0]!.data!.attachmentId).toBe(attachmentId);
    expect(added[0]!.data!.kind).toBe("frames");
    expect(added[0]!.data!.size).toBe(PNG.byteLength);
  });

  it("redteam (edge): a refused frame (not a PNG) appends no file_added", async () => {
    const r = await seedReport();
    await expectError(await postFrame(r.code, pattern(4, 0, 64)), 400, ERRORS.invalidMime);
    expect(await eventTypesOf(r.id)).not.toContain("file_added");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Astra CONCEPT cron.ts:149, STATE cron.ts:143, STATE cron.ts:110 and decisions 1-3: 12-month retention.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam: 12-month retention", () => {
  async function liveKeysUnder(prefix: string): Promise<string[]> {
    const listed = await env.FILES.list({ prefix, limit: 1000 });
    return listed.objects.map((o) => o.key);
  }

  async function attachmentCount(reportId: string): Promise<number> {
    const r = await env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE report_id = ?").bind(reportId).first<{ n: number }>();
    return r!.n;
  }

  /** Every object still in R2 under `prefix` has an attachment row: none was orphaned by a row deleted too early. */
  async function expectNoOrphans(prefix: string): Promise<void> {
    const keys = await liveKeysUnder(prefix);
    if (keys.length === 0) return;
    // substr, not LIKE: D1 refuses a LIKE pattern over 50 bytes and the prefix holds a report id.
    const rows = await env.DB.prepare("SELECT r2_key FROM attachments WHERE substr(r2_key, 1, length(?1)) = ?1")
      .bind(prefix)
      .all<{ r2_key: string }>();
    const known = new Set(rows.results.map((x) => x.r2_key));
    for (const key of keys) expect(known.has(key), `object ${key} still in R2 has an attachment row`).toBe(true);
  }

  /** Runs the cron until `gone()` holds or MAX_CRON_RUNS runs have passed; returns the number of runs used. */
  async function cronUntil(gone: () => Promise<boolean>, eachRun: () => Promise<void> = async () => {}): Promise<number> {
    for (let run = 1; run <= MAX_CRON_RUNS; run++) {
      await runCron();
      await eachRun();
      if (await gone()) return run;
    }
    return MAX_CRON_RUNS + 1;
  }

  it("redteam: a 12-month report whose aborted attachment still has an object in R2 loses the object", async () => {
    const created = Date.now() - 400 * DAY;
    const r = await seedReport({ created_at: created });
    const a = await seedAttachment(r.id, { created_at: created, status: "aborted", upload_id: null, r2_key: `spec/rt-aborted/${r.id}` });
    await env.FILES.put(a.r2_key, pattern(7, 0, 100));

    const runs = await cronUntil(async () => (await env.FILES.head(a.r2_key)) === null && (await reportByCode(r.code)) === null);

    expect(runs).toBeLessThanOrEqual(MAX_CRON_RUNS);
  });

  it("redteam: a 12-month report whose aborted attachment's multipart upload is still open has it aborted", async () => {
    const created = Date.now() - 400 * DAY;
    const r = await seedReport({ created_at: created });
    const key = `spec/rt-open/${r.id}`;
    const upload = await env.FILES.createMultipartUpload(key);
    await upload.uploadPart(1, pattern(8, 0, 5 * 1024 * 1024));
    // The row says aborted (the cron claimed it) but R2 never took the abort: Astra's cron.ts:110 state.
    await seedAttachment(r.id, { created_at: created, status: "aborted", r2_key: key, upload_id: upload.uploadId, part_count: 2, part_size: 16 * 1024 * 1024 });

    const stillOpen = async () => {
      try {
        await env.FILES.resumeMultipartUpload(key, upload.uploadId).uploadPart(2, pattern(8, 1, 10));
        return true;
      } catch {
        return false;
      }
    };
    const runs = await cronUntil(async () => (await reportByCode(r.code)) === null && !(await stillOpen()));

    expect(runs).toBeLessThanOrEqual(MAX_CRON_RUNS);
    expect(await env.FILES.head(key)).toBeNull();
  });

  it("redteam: a frame the agent adds while the cron deletes an old report's objects is never left in R2 without a row", async () => {
    const created = Date.now() - 400 * DAY;
    const r = await seedReport({ created_at: created });
    const first = await seedAttachment(r.id, { created_at: created, kind: "frames", mime: "image/png", r2_key: `spec/rt-race/${r.id}/first` });
    await env.FILES.put(first.r2_key, PNG);

    let added: { id: string; key: string } | null = null;
    const { files, fired } = filesWithGapBeforeDeleteOf(first.r2_key, async () => {
      // The agent's frame upload lands after the cron listed this report's attachments, before it deletes rows.
      const res = await postFrame(r.code);
      expect(res.status, "the mid-run frame upload").toBe(201);
      const id = (await body<{ attachmentId: string }>(res)).attachmentId;
      const row = await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(id).first<{ r2_key: string }>();
      added = { id, key: row!.r2_key };
    });

    await runCron({ FILES: files });

    expect(fired(), "the cron deleted the old report's first object").toBe(true);
    const frame = added as { id: string; key: string } | null;
    expect(frame).not.toBeNull();
    const rowLeft = (await env.DB.prepare("SELECT 1 AS x FROM attachments WHERE id = ?").bind(frame!.id).first()) !== null;
    const objectLeft = (await env.FILES.head(frame!.key)) !== null;
    expect({ rowLeft, objectLeft }, "the new frame keeps its row while its object exists").not.toEqual({ rowLeft: false, objectLeft: true });
    if (objectLeft) expect(await reportByCode(r.code), "the report waits for its remaining attachment").not.toBeNull();

    const runs = await cronUntil(async () => (await reportByCode(r.code)) === null && (await env.FILES.head(frame!.key)) === null);
    expect(runs).toBeLessThanOrEqual(MAX_CRON_RUNS);
  });

  // Last in this block: on code without decision 1 the 501-frame report stays and blocks every later old report,
  // which would make the specs above fail for its reason instead of their own.
  it("redteam: a 12-month report with 501 frames is fully gone within 3 cron runs, and an old report behind it too", async () => {
    const created = Date.now() - 400 * DAY;
    const big = await seedReport({ created_at: created });
    const prefix = `spec/rt-frames/${big.id}/`;
    const insert = env.DB.prepare(
      `INSERT INTO attachments (id, report_id, created_at, kind, filename, mime, size_bytes, r2_key, status, completed_at)
       VALUES (?, ?, ?, 'frames', 'frame.png', 'image/png', 1, ?, 'complete', ?)`,
    );
    const keys = Array.from({ length: 501 }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
    await env.DB.batch(keys.map((key, i) => insert.bind(`${big.id}-f${i}`, big.id, created, key, created)));
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(keys.slice(i, i + 50).map((key) => env.FILES.put(key, new Uint8Array([i & 0xff]))));
    }
    expect(await liveKeysUnder(prefix), "all 501 seeded objects exist").toHaveLength(501);

    const behind = await seedReport({ created_at: created + DAY });
    const behindAtt = await seedAttachment(behind.id, { created_at: created + DAY, completed_at: created + DAY, r2_key: `spec/rt-behind/${behind.id}` });
    await env.FILES.put(behindAtt.r2_key, new Uint8Array([1, 2, 3]));

    const runs = await cronUntil(
      async () =>
        (await reportByCode(big.code)) === null &&
        (await reportByCode(behind.code)) === null &&
        (await liveKeysUnder(prefix)).length === 0 &&
        (await env.FILES.head(behindAtt.r2_key)) === null,
      () => expectNoOrphans(prefix),
    );

    expect(runs, "cron runs needed (more than 3 means it never finished)").toBeLessThanOrEqual(MAX_CRON_RUNS);
    expect(await attachmentCount(big.id)).toBe(0);
    expect(await attachmentCount(behind.id)).toBe(0);
    expect(await eventTypesOf(big.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Opus STATE agent.ts:179 (and agent.ts:209) and decision 6: `from` is read inside the write.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam: a desk status change between a route's read and its write", () => {
  it("redteam: re-triage of a looking report after the desk set fixed records status_changed fixed -> looking", async () => {
    const r = await seedReport({ status: "looking", verdict: "needs_person" });
    const { db, fired } = dbWithGapBeforeFirstBatch(async () => {
      expect((await deskStatus(r.code, { status: "fixed" })).status, "the desk change in the gap").toBe(200);
    });

    const res = await triage(r.code, { verdict: "simple_fix", triage: { summary: "simple after all" } }, { DB: db });

    expect(res.status).toBe(200);
    expect(fired(), "triage wrote through one batch after its read").toBe(true);
    expect((await reportByCode(r.code))!.status).toBe("looking");
    const changes = await statusChanges(r.id);
    expect(changes.at(-1)).toMatchObject({ from: "fixed", to: "looking" });
  });

  it("redteam: an agent status change after the desk set fixed records from fixed, not the stale looking", async () => {
    const r = await seedReport({ status: "looking" });
    const { db, fired } = dbWithGapBeforeFirstBatch(async () => {
      expect((await deskStatus(r.code, { status: "fixed" })).status, "the desk change in the gap").toBe(200);
    });

    const res = await agentStatus(r.code, { status: "closed", note: "spam" }, { DB: db });

    expect(res.status).toBe(200);
    expect(fired(), "the status route wrote through one batch after its read").toBe(true);
    expect((await reportByCode(r.code))!.status).toBe("closed");
    const changes = await statusChanges(r.id);
    expect(changes.at(-1)).toMatchObject({ from: "fixed", to: "closed" });
  });
});

// ===============================================================================================================
// Round 2 (redteam-astra-2.md, redteam-opus-2.md) and the lead's decisions 1-3 of brief-fix-rt2.md.
// ===============================================================================================================

// ---------------------------------------------------------------------------------------------------------------
// Astra and Opus STATE uploads.ts:113 and decision 1: an obsolete part etag makes the upload recoverable, not stuck.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam-2: a part etag overwritten by a late re-send", () => {
  type Uploaded = { uploaded: { n: number; size: number }[] };

  async function putOk(id: string, n: number, token: string, bytes: Uint8Array): Promise<string> {
    const res = await putPart(id, n, token, bytes);
    expect(res.status, `PUT part ${n}`).toBe(200);
    return (await body<{ etag: string }>(res)).etag;
  }

  async function fileAddedCount(reportId: string): Promise<number> {
    return (await eventTypesOf(reportId)).filter((t) => t === "file_added").length;
  }

  it("redteam-2: complete with an obsolete etag stored for part 2 is 409 missing_parts [1, 2, 3], parts cleared; re-send and complete is 200, byte-identical, one file_added", async () => {
    const sizes = [PART_SIZE, PART_SIZE, 1000];
    const total = sizes.reduce((a, b) => a + b, 0);
    const r = await createReport();
    const created = await createAttachment(r.code, r.reportToken, { size: total });
    expect(created.status, "creating the attachment").toBe(201);
    const id = (await body<{ attachmentId: string }>(created)).attachmentId;
    const reportId = (await reportByCode(r.code))!.id;
    const right = [pattern(21, 0, sizes[0]!), pattern(21, PART_SIZE, sizes[1]!), pattern(21, 2 * PART_SIZE, sizes[2]!)];

    await putOk(id, 1, r.reportToken, right[0]!);
    // PUT A of part 2 (its bytes differ, so R2 gives its part a different etag), then PUT B replaces it in R2.
    const etagA = await putOk(id, 2, r.reportToken, pattern(77, 0, PART_SIZE));
    const etagB = await putOk(id, 2, r.reportToken, right[1]!);
    expect(etagA, "the two sends of part 2 have different etags").not.toBe(etagB);
    await putOk(id, 3, r.reportToken, right[2]!);
    // A's delayed upsert lands after B's: D1 now holds the etag R2 no longer knows for part 2.
    const stale = await env.DB.prepare("UPDATE parts SET etag = ? WHERE attachment_id = ? AND n = 2").bind(etagA, id).run();
    expect(stale.meta.changes, "the part 2 row was overwritten").toBe(1);

    const first = await completeUpload(id, r.reportToken);
    expect(first.status, "complete with the obsolete etag (never 500)").not.toBe(500);
    const refused = await expectError(first, 409, ERRORS.missingParts);
    expect(Object.values(refused).filter(Array.isArray)).toEqual([[1, 2, 3]]);

    const list = await listParts(id, r.reportToken);
    expect(list.status).toBe(200);
    expect((await body<Uploaded>(list)).uploaded).toEqual([]);
    const row = await attachmentById(id);
    expect(row!.status, "the upload stays open for the re-send").toBe("uploading");
    expect(await fileAddedCount(reportId)).toBe(0);

    // A client retrying complete before re-sending gets the same 409, not a 500.
    const again = await completeUpload(id, r.reportToken);
    expect(again.status).not.toBe(500);
    expect(Object.values(await expectError(again, 409, ERRORS.missingParts)).filter(Array.isArray)).toEqual([[1, 2, 3]]);

    for (const [i, bytes] of right.entries()) await putOk(id, i + 1, r.reportToken, bytes);
    const done = await completeUpload(id, r.reportToken);
    expect(done.status).toBe(200);

    const after = await attachmentById(id);
    expect(after!.status).toBe("complete");
    const obj = await env.FILES.get(after!.r2_key);
    expect(obj, "the object exists after the second complete").not.toBeNull();
    expect(obj!.size).toBe(total);
    expect(await sha256Hex(await obj!.arrayBuffer())).toBe(await sha256OfParts(right));
    expect(await fileAddedCount(reportId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Astra STATE cron.ts:110 and decision 2: an `aborted` row that still holds an upload id is retried the next day.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam-2: aborted uploads left by a failed cron run", () => {
  /** An attachment row in `aborted` with a live upload id, `ageDays` old, on a recent report (no 12-month purge). */
  async function seedAbortedWithUpload(ageDays: number, finished: boolean) {
    const created = Date.now() - ageDays * DAY;
    const r = await seedReport({ created_at: created });
    const key = `spec/rt2-aborted/${crypto.randomUUID()}`;
    const upload = await env.FILES.createMultipartUpload(key);
    const part = await upload.uploadPart(1, pattern(22, 0, 1000));
    // R2 took the complete, D1 never heard of it: the object exists while the row says aborted.
    if (finished) await upload.complete([part]);
    const a = await seedAttachment(r.id, {
      created_at: created,
      status: "aborted",
      r2_key: key,
      upload_id: upload.uploadId,
      part_size: PART_SIZE,
      part_count: 1,
      size_bytes: 1000,
    });
    return { key, uploadId: upload.uploadId, attachment: a };
  }

  async function stillOpen(key: string, uploadId: string): Promise<boolean> {
    try {
      await env.FILES.resumeMultipartUpload(key, uploadId).uploadPart(2, pattern(22, 1, 10));
      return true;
    } catch {
      // R2 refuses a part for an aborted or completed upload: it is closed.
      return false;
    }
  }

  it("redteam-2: an 8-day aborted row whose R2 upload was completed loses its object in one run and keeps no live upload id", async () => {
    const s = await seedAbortedWithUpload(8, true);
    expect(await env.FILES.head(s.key), "the finished object exists before the run").not.toBeNull();

    await runCron();

    expect(await env.FILES.head(s.key)).toBeNull();
    const row = await attachmentById(s.attachment.id);
    const settled = row === null || row.status === "deleted" || row.upload_id === null;
    expect(settled, `row after one run: ${JSON.stringify(row && { status: row.status, upload_id: row.upload_id })}`).toBe(true);
  });

  it("redteam-2 (edge): an 8-day aborted row whose R2 upload is still open has it aborted in one run and its upload id cleared", async () => {
    const s = await seedAbortedWithUpload(8, false);
    expect(await stillOpen(s.key, s.uploadId), "the upload is open before the run").toBe(true);

    await runCron();

    expect(await stillOpen(s.key, s.uploadId)).toBe(false);
    expect(await env.FILES.head(s.key)).toBeNull();
    const row = await attachmentById(s.attachment.id);
    expect(row === null || row.upload_id === null || row.status === "deleted", "no live upload id left").toBe(true);
  });

  it("redteam-2 (edge): a 6-day aborted row with a finished object is not touched yet (the 7-day line)", async () => {
    const s = await seedAbortedWithUpload(6, true);

    await runCron();

    expect(await env.FILES.head(s.key)).not.toBeNull();
    const row = await attachmentById(s.attachment.id);
    expect(row!.status).toBe("aborted");
    expect(row!.upload_id).toBe(s.uploadId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Astra CONCEPT status.ts:21 / agent.ts:205 and decision 3: links made in reverse order are flattened too.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam-2: duplicate links made from the leaf towards the root", () => {
  it("redteam-2: R0 -> R1 then R1 -> R2 (fixed): R0 shows fixed and stores R2 as its original", async () => {
    const r0 = await seedReport();
    const r1 = await seedReport();
    const r2 = await seedReport({ status: "fixed" });

    expect((await linkDuplicate(r0.code, r1.code)).status, "R0 -> R1").toBe(200);
    expect((await linkDuplicate(r1.code, r2.code)).status, "R1 -> R2").toBe(200);

    expect(await publicStatus(r0.code)).toBe("fixed");
    expect((await reportByCode(r0.code))!.duplicate_of).toBe(r2.code);
    expect((await reportByCode(r1.code))!.duplicate_of).toBe(r2.code);
  });

  it("redteam-2: a chain of 11 links made one at a time, R0 -> R1 first and R10 -> R11 (fixed) last, shows fixed on R0", async () => {
    const reports: ReportRow[] = [];
    for (let i = 0; i < 11; i++) reports.push(await seedReport());
    const root = await seedReport({ status: "fixed" });
    reports.push(root);

    for (let i = 0; i < 11; i++) {
      expect((await linkDuplicate(reports[i]!.code, reports[i + 1]!.code)).status, `R${i} -> R${i + 1}`).toBe(200);
    }

    expect(await publicStatus(reports[0]!.code)).toBe("fixed");
    for (const [i, r] of reports.slice(0, 11).entries()) {
      expect((await reportByCode(r.code))!.duplicate_of, `R${i} points at the root`).toBe(root.code);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 3 (redteam-astra-3.md), finding 1: two triages that close a cycle at the same instant. The cycle check and
// the write must be one atomic step: one wins, the other is 409 duplicate_cycle and leaves its report as it was.
// ---------------------------------------------------------------------------------------------------------------

const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;

/**
 * A D1 binding as the real one, except that the first write the route sends (a `batch`, or a single INSERT/UPDATE
 * statement run on its own) first awaits `gap()`. Unlike dbWithGapBeforeFirstBatch it does not assume the route
 * writes through a batch: an atomic conditional statement is a write too, and the gap lands right before it.
 */
function dbWithGapBeforeFirstWrite(gap: () => Promise<void>): { db: D1Database; fired: () => boolean } {
  let fired = false;
  const real = env.DB;
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  async function once(): Promise<void> {
    if (fired) return;
    fired = true;
    await gap();
  }
  function wrap(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if ((prop === "run" || prop === "first" || prop === "all" || prop === "raw") && WRITE_SQL.test(sql)) {
          return async (...args: unknown[]) => {
            await once();
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    unwrap.set(proxy, stmt);
    return proxy;
  }
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
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

type Snapshot = { status: string; verdict: string | null; duplicate_of: string | null; events: EventRow[] };

async function snapshot(r: ReportRow): Promise<Snapshot> {
  const row = (await reportByCode(r.code))!;
  return { status: row.status, verdict: row.verdict, duplicate_of: row.duplicate_of, events: await eventsOf(r.id) };
}

/** Follows the stored duplicate_of links from `code`: none of them may come back to a report already visited. */
async function expectNoLoopFrom(code: string): Promise<void> {
  const seen = new Set<string>();
  let at: string | null = code;
  for (let hop = 0; at !== null && hop < 20; hop++) {
    expect(seen.has(at), `the duplicate_of links from ${code} come back to ${at}`).toBe(false);
    seen.add(at);
    const row: ReportRow | null = await reportByCode(at);
    if (row === null) return;
    expect(row.duplicate_of, `${at} is linked to itself`).not.toBe(at);
    at = row.duplicate_of;
  }
  expect(at, `the duplicate_of links from ${code} never end`).toBeNull();
}

/**
 * The outcome row 1 asks for, whatever order the two requests landed in: exactly one 200 and one 409
 * duplicate_cycle, no loop, the loser exactly as it was before, the winner showing the loser's public status.
 */
async function expectOneWinner(
  pair: [ReportRow, ReportRow],
  answers: [Response, Response],
  before: [Snapshot, Snapshot],
  label: string,
): Promise<void> {
  const statuses = answers.map((a) => a.status);
  expect([...statuses].sort(), `${label}: one 200 and one 409`).toEqual([200, 409]);
  const loserIndex = statuses.indexOf(409);
  const winner = pair[1 - loserIndex]!;
  const loser = pair[loserIndex]!;
  await expectError(answers[loserIndex]!, 409, "duplicate_cycle");

  await expectNoLoopFrom(pair[0].code);
  await expectNoLoopFrom(pair[1].code);
  const rows = [(await reportByCode(pair[0].code))!, (await reportByCode(pair[1].code))!];
  expect(rows.filter((r) => r.status === "duplicate").length, `${label}: at most one of the two is a duplicate`).toBeLessThanOrEqual(1);

  expect(await snapshot(loser), `${label}: the loser ${loser.code} is unchanged`).toEqual(before[loserIndex]);
  const w = (await reportByCode(winner.code))!;
  expect(w.status).toBe("duplicate");
  expect(w.duplicate_of).toBe(loser.code);

  const loserPublic = await publicStatus(loser.code);
  expect(loserPublic, "the loser is seeded looking and stays looking").toBe("looking");
  expect(await publicStatus(winner.code), `${label}: the winner shows its original's status, not a loop's checked`).toBe(
    loserPublic,
  );
}

describe("redteam-3: two triages closing a duplicate cycle at the same instant", () => {
  it("redteam-3: B -> A landing between A -> B's check and its write: A -> B is 409 duplicate_cycle, B -> A stands", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport({ status: "looking" });
    const beforeA = await snapshot(a);
    let gapAnswer = 0;
    const { db, fired } = dbWithGapBeforeFirstWrite(async () => {
      gapAnswer = (await linkDuplicate(b.code, a.code)).status;
    });

    const res = await triage(a.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: b.code }, { DB: db });

    expect(fired(), "A -> B wrote after its read").toBe(true);
    expect(gapAnswer, "B -> A in the gap").toBe(200);
    await expectError(res, 409, "duplicate_cycle");
    await expectNoLoopFrom(a.code);
    await expectNoLoopFrom(b.code);
    expect(await snapshot(a), "A is unchanged").toEqual(beforeA);
    expect((await reportByCode(b.code))!.duplicate_of).toBe(a.code);
    expect(await publicStatus(b.code)).toBe("looking");
    expect(await publicStatus(a.code)).toBe("looking");
  });

  it("redteam-3: fifteen pairs A -> B and B -> A posted together: each pair has one winner and one duplicate_cycle", async () => {
    for (let i = 0; i < 15; i++) {
      const a = await seedReport({ status: "looking" });
      const b = await seedReport({ status: "looking" });
      const before: [Snapshot, Snapshot] = [await snapshot(a), await snapshot(b)];

      const answers = await Promise.all([linkDuplicate(a.code, b.code), linkDuplicate(b.code, a.code)]);

      await expectOneWinner([a, b], answers, before, `pair #${i + 1}`);
    }
  });

  it("redteam-3: A -> B, B -> C and C -> A posted together leave no loop and at least one duplicate_cycle", async () => {
    for (let i = 0; i < 5; i++) {
      const reports = [await seedReport({ status: "looking" }), await seedReport({ status: "looking" }), await seedReport({ status: "looking" })];
      const answers = await Promise.all(reports.map((r, k) => linkDuplicate(r.code, reports[(k + 1) % 3]!.code)));

      const statuses = answers.map((x) => x.status);
      expect(statuses.every((s) => s === 200 || s === 409), `round #${i + 1}: ${statuses.join(",")}`).toBe(true);
      expect(statuses.filter((s) => s === 409).length, `round #${i + 1}: at least one refused`).toBeGreaterThanOrEqual(1);
      for (const x of answers) if (x.status === 409) await expectError(x, 409, "duplicate_cycle");
      for (const r of reports) await expectNoLoopFrom(r.code);
      const rows = await Promise.all(reports.map((r) => reportByCode(r.code)));
      expect(rows.some((r) => r!.status !== "duplicate"), `round #${i + 1}: one report is still an original`).toBe(true);
      for (const r of reports) expect(await publicStatus(r.code), `round #${i + 1}: ${r.code}`).toBe("looking");
    }
  });

  // Audit round 1, findings 2-3: the root A -> B read moves before A's write. The decided retry reads the chain again
  // and links A to where B went (C), one hop: not 409 for a legitimate link, and not A -> B -> C.
  it("redteam-3: B -> C landing between A -> B's read and its write: A -> B is 200 and stores C, one hop, one event", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport({ status: "looking" });
    const c = await seedReport({ status: "looking" });
    const beforeA = await eventsOf(a.id);
    let gapAnswer = 0;
    const { db, fired } = dbWithGapBeforeFirstWrite(async () => {
      gapAnswer = (await linkDuplicate(b.code, c.code)).status;
    });

    const res = await triage(a.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: b.code }, { DB: db });

    expect(fired(), "A -> B wrote after its read").toBe(true);
    expect(gapAnswer, "B -> C in the gap").toBe(200);
    expect(res.status, "A -> B after the root moved").toBe(200);
    const rowA = (await reportByCode(a.code))!;
    expect(rowA.status).toBe("duplicate");
    expect(rowA.duplicate_of, "A points at C, one hop, not at B").toBe(c.code);
    expect((await reportByCode(b.code))!.duplicate_of).toBe(c.code);
    await expectNoLoopFrom(a.code);

    const all = await eventsOf(a.id);
    expect(all.slice(0, beforeA.length), "A's old events are untouched").toEqual(beforeA);
    const added = all.slice(beforeA.length);
    const linked = added.filter((e) => e.type === "duplicate_linked");
    expect(linked.length, "A has exactly one duplicate_linked").toBe(1);
    expect(linked[0]!.data).toEqual({ duplicateOf: c.code });
    expect(added.filter((e) => e.type === "triaged").length, "A has exactly one triaged").toBe(1);
    expect(added.filter((e) => e.type === "status_changed").length, "A has exactly one status_changed").toBe(1);
    expect(await publicStatus(a.code), "A shows C's status").toBe("looking");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 3, finding 2: a report re-pointed to a new root gets its own duplicate_linked event (the bot posts
// "Same bug" in that report's thread from it), as the report that was triaged does.
// ---------------------------------------------------------------------------------------------------------------

describe("redteam-3: duplicate_linked for every report re-pointed to the new root", () => {
  function linkedEvents(events: EventRow[]): EventRow[] {
    return events.filter((e) => e.type === "duplicate_linked");
  }

  /** Events of `r` written after the snapshot `before` (the log is append-only). */
  async function newEvents(r: ReportRow, before: EventRow[]): Promise<EventRow[]> {
    const all = await eventsOf(r.id);
    expect(all.slice(0, before.length), `${r.code}: the old events are untouched`).toEqual(before);
    return all.slice(before.length);
  }

  it("redteam-3: C -> B, then B -> A: C points at A and gets its own duplicate_linked to A, like B", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    const c = await seedReport();
    expect((await linkDuplicate(c.code, b.code)).status, "C -> B").toBe(200);
    const beforeA = await eventsOf(a.id);
    const beforeB = await eventsOf(b.id);
    const beforeC = await eventsOf(c.id);

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    expect((await reportByCode(b.code))!.duplicate_of).toBe(a.code);
    expect((await reportByCode(c.code))!.duplicate_of).toBe(a.code);
    const bLinked = linkedEvents(await newEvents(b, beforeB));
    const cLinked = linkedEvents(await newEvents(c, beforeC));
    expect(bLinked.length, "B has one new duplicate_linked").toBe(1);
    expect(bLinked[0]!.data).toMatchObject({ duplicateOf: a.code });
    expect(cLinked.length, "C has one new duplicate_linked").toBe(1);
    expect(cLinked[0]!.data).toMatchObject({ duplicateOf: a.code });
    expect(Object.keys(cLinked[0]!.data!), "C's event has the fields of B's").toEqual(
      expect.arrayContaining(Object.keys(bLinked[0]!.data!)),
    );
    expect(await newEvents(a, beforeA), "A, the root, gets no event").toEqual([]);
  });

  it("redteam-3: the bot sees C's duplicate_linked through GET /agent/events with C's code and A in its data", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    const c = await seedReport();
    expect((await linkDuplicate(c.code, b.code)).status, "C -> B").toBe(200);
    const max = await env.DB.prepare("SELECT max(seq) AS m FROM events").first<{ m: number | null }>();

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    const res = await call(`/agent/events?after=${max!.m ?? 0}&limit=100`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    type Ev = { code: string; type: string; data: unknown };
    const events = (await body<{ events: Ev[] }>(res)).events;
    const forC = events.filter((e) => e.code === c.code && e.type === "duplicate_linked");
    expect(forC.length, "one duplicate_linked for C").toBe(1);
    const data = typeof forC[0]!.data === "string" ? JSON.parse(forC[0]!.data as string) : forC[0]!.data;
    expect(data).toMatchObject({ duplicateOf: a.code });
  });

  it("redteam-3 (edge): C1 and C2 both -> B, then B -> A: each gets exactly one new duplicate_linked to A", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    const c1 = await seedReport();
    const c2 = await seedReport();
    expect((await linkDuplicate(c1.code, b.code)).status, "C1 -> B").toBe(200);
    expect((await linkDuplicate(c2.code, b.code)).status, "C2 -> B").toBe(200);
    const before1 = await eventsOf(c1.id);
    const before2 = await eventsOf(c2.id);

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    for (const [r, before] of [
      [c1, before1],
      [c2, before2],
    ] as const) {
      expect((await reportByCode(r.code))!.duplicate_of, `${r.code} points at A`).toBe(a.code);
      const linked = linkedEvents(await newEvents(r, before));
      expect(linked.length, `${r.code}: exactly one new duplicate_linked`).toBe(1);
      expect(linked[0]!.data).toMatchObject({ duplicateOf: a.code });
    }
  });

  it("redteam-3 (edge): D, a duplicate of another original E, is not re-pointed and gets no event", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    const c = await seedReport();
    const e = await seedReport({ status: "looking" });
    const d = await seedReport();
    expect((await linkDuplicate(c.code, b.code)).status, "C -> B").toBe(200);
    expect((await linkDuplicate(d.code, e.code)).status, "D -> E").toBe(200);
    const beforeD = await eventsOf(d.id);
    const beforeE = await eventsOf(e.id);

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    expect((await reportByCode(d.code))!.duplicate_of).toBe(e.code);
    expect(await newEvents(d, beforeD), "D gets no event").toEqual([]);
    expect(await newEvents(e, beforeE), "E gets no event").toEqual([]);
    expect((await reportByCode(c.code))!.duplicate_of, "C, on B, is re-pointed").toBe(a.code);
  });

  it("redteam-3 (edge): B -> A with nobody pointing at B writes duplicate_linked for B only", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    const max = await env.DB.prepare("SELECT max(seq) AS m FROM events").first<{ m: number | null }>();

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    const linked = await env.DB.prepare("SELECT report_id FROM events WHERE seq > ? AND type = 'duplicate_linked'")
      .bind(max!.m ?? 0)
      .all<{ report_id: string }>();
    expect(linked.results.map((x) => x.report_id)).toEqual([b.id]);
  });

  it("redteam-3 (edge): a refused B -> A (it would close a cycle) re-points nobody and writes no event for C", async () => {
    const b = await seedReport();
    const c = await seedReport();
    const a = await seedReport();
    expect((await linkDuplicate(c.code, b.code)).status, "C -> B").toBe(200);
    expect((await linkDuplicate(a.code, c.code)).status, "A -> C, stored as A -> B").toBe(200);
    const beforeC = await eventsOf(c.id);

    await expectError(await linkDuplicate(b.code, a.code), 409, "duplicate_cycle");

    expect((await reportByCode(c.code))!.duplicate_of).toBe(b.code);
    expect(await newEvents(c, beforeC), "C gets no event").toEqual([]);
  });

  // Audit round 1, finding 1 and the lead's decision: only reports whose status is `duplicate` and that point at the
  // triaged report are re-pointed, and never the new root itself. The desk changes `status` only, so a report a
  // person took back out of `duplicate` keeps its old `duplicate_of` in storage.
  it("redteam-3: B -> A, the desk sets B back to looking, then A -> B: 200, B is not linked to itself, no event for B", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport({ status: "looking" });
    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);
    expect((await deskStatus(b.code, { status: "looking" })).status, "the desk sets B back to looking").toBe(200);
    const stored = (await reportByCode(b.code))!;
    expect(stored.status).toBe("looking");
    expect(stored.duplicate_of, "the desk changes status only").toBe(a.code);
    const beforeB = await eventsOf(b.id);

    expect((await linkDuplicate(a.code, b.code)).status, "A -> B").toBe(200);

    expect((await reportByCode(a.code))!.duplicate_of).toBe(b.code);
    const rowB = (await reportByCode(b.code))!;
    expect(rowB.duplicate_of, "B is not linked to itself").not.toBe(b.code);
    expect(rowB.duplicate_of, "B keeps its stored link").toBe(a.code);
    expect(rowB.status).toBe("looking");
    expect(linkedEvents(await newEvents(b, beforeB)), "B gets no duplicate_linked").toEqual([]);
    expect(await publicStatus(a.code), "A shows B's public status").toBe("looking");
  });

  it("redteam-3 (edge): C -> B, the desk sets C to fixed, then B -> A: C is not re-pointed and gets no event", async () => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport({ status: "looking" });
    const c = await seedReport({ status: "looking" });
    expect((await linkDuplicate(c.code, b.code)).status, "C -> B").toBe(200);
    expect((await deskStatus(c.code, { status: "fixed" })).status, "the desk sets C to fixed").toBe(200);
    const beforeB = await eventsOf(b.id);
    const beforeC = await eventsOf(c.id);

    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    const rowC = (await reportByCode(c.code))!;
    expect(rowC.duplicate_of, "C still points at B in storage").toBe(b.code);
    expect(rowC.status, "C is still fixed").toBe("fixed");
    expect(linkedEvents(await newEvents(c, beforeC)), "C gets no duplicate_linked").toEqual([]);
    const bLinked = linkedEvents(await newEvents(b, beforeB));
    expect(bLinked.length, "B has its own duplicate_linked").toBe(1);
    expect(bLinked[0]!.data).toMatchObject({ duplicateOf: a.code });
  });
});

// ===============================================================================================================
// Round 4 (slice worker-status, brief-tests.md): manual status changes never revive a duplicate link, a report or
// root deleted by retention between the triage's read and its write, and a chain still moving after the two
// attempts. Lead's decisions: a status other than `duplicate` clears duplicate_of in the same write; `duplicate` by
// hand needs a valid `duplicateOf` and goes through the triage link (root, re-pointing, cycle guard); a vanished
// report or root writes nothing; a chain that moved under both guarded writes is 409 duplicate_busy + Retry-After.
// ===============================================================================================================

type FullSnapshot = {
  status: string;
  verdict: string | null;
  triage: string | null;
  duplicate_of: string | null;
  pr_url: string | null;
  updated_at: number;
  events: EventRow[];
};

/** Everything a refused request must leave as it was, the events included. */
async function fullSnapshot(r: ReportRow): Promise<FullSnapshot> {
  const row = (await reportByCode(r.code))!;
  return {
    status: row.status,
    verdict: row.verdict,
    triage: row.triage,
    duplicate_of: row.duplicate_of,
    pr_url: row.pr_url,
    updated_at: row.updated_at,
    events: await eventsOf(r.id),
  };
}

/** Events of `r` written after `before` (the log is append-only). */
async function eventsAfter(r: ReportRow, before: EventRow[]): Promise<EventRow[]> {
  const all = await eventsOf(r.id);
  expect(all.slice(0, before.length), `${r.code}: the old events are untouched`).toEqual(before);
  return all.slice(before.length);
}

async function maxSeq(): Promise<number> {
  const r = await env.DB.prepare("SELECT max(seq) AS m FROM events").first<{ m: number | null }>();
  return r!.m ?? 0;
}

/** Event rows written after `seq` for any of `reportIds`, whether or not the report still exists. */
async function eventsSince(seq: number, reportIds: string[]): Promise<{ report_id: string; type: string }[]> {
  const marks = reportIds.map(() => "?").join(", ");
  const r = await env.DB.prepare(`SELECT report_id, type FROM events WHERE seq > ? AND report_id IN (${marks}) ORDER BY seq`)
    .bind(seq, ...reportIds)
    .all<{ report_id: string; type: string }>();
  return r.results;
}

/** What the daily retention does to a 12-month report (worker/src/cron.ts deleteOldReports), run as plain SQL. */
async function deleteAsRetention(r: ReportRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE id = ?1").bind(r.id),
    env.DB.prepare("DELETE FROM events WHERE report_id = ?1").bind(r.id),
    env.DB.prepare("DELETE FROM report_tokens WHERE report_id = ?1").bind(r.id),
  ]);
  expect(await reportByCode(r.code), `${r.code} is gone`).toBeNull();
}

/**
 * Like dbWithGapBeforeFirstWrite, but `gap()` runs before every write the route sends (each `batch`, each lone
 * INSERT/UPDATE/DELETE), at most `limit` times: another writer that lands before each guarded attempt.
 */
function dbWithGapBeforeEveryWrite(gap: () => Promise<void>, limit: number): { db: D1Database; gaps: () => number } {
  let gaps = 0;
  const real = env.DB;
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  async function each(): Promise<void> {
    if (gaps >= limit) return;
    gaps += 1;
    await gap();
  }
  function wrap(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if ((prop === "run" || prop === "first" || prop === "all" || prop === "raw") && WRITE_SQL.test(sql)) {
          return async (...args: unknown[]) => {
            await each();
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    unwrap.set(proxy, stmt);
    return proxy;
  }
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await each();
          return target.batch(statements.map((s) => unwrap.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, gaps: () => gaps };
}

/** The stored root of `code`: follows duplicate_of (bounded) to the report that has none. */
async function storedRoot(code: string): Promise<string> {
  let at = code;
  for (let hop = 0; hop < 20; hop++) {
    const row = (await reportByCode(at))!;
    if (row.duplicate_of === null) return at;
    at = row.duplicate_of;
  }
  throw new Error(`no root from ${code}`);
}

describe("redteam-4: a status route leaving duplicate clears the link (row 1)", () => {
  it.each(statusRoutes)("redteam-4: %s B -> A, B set back to looking, then A -> B: 200, A points at B, no self-link, nothing checked", async (_route, post) => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);

    expect((await post(b.code, { status: "looking" })).status, "B back to looking").toBe(200);
    const cleared = (await reportByCode(b.code))!;
    expect(cleared.status).toBe("looking");
    expect(cleared.duplicate_of, "leaving duplicate clears the stored link").toBeNull();
    expect(cleared.verdict, "the status route never changes verdict").toBe("duplicate");

    expect((await linkDuplicate(a.code, b.code)).status, "A -> B").toBe(200);

    const rowA = (await reportByCode(a.code))!;
    const rowB = (await reportByCode(b.code))!;
    expect(rowA.status).toBe("duplicate");
    expect(rowA.duplicate_of).toBe(b.code);
    expect(rowB.status, "B is not a duplicate").not.toBe("duplicate");
    expect(rowB.duplicate_of, "B is not re-pointed to itself").toBeNull();
    expect(rowA.duplicate_of).not.toBe(a.code);
    await expectNoLoopFrom(a.code);
    await expectNoLoopFrom(b.code);
    expect(await publicStatus(b.code)).toBe("looking");
    expect(await publicStatus(a.code), "A shows B's looking, not a loop's checked").toBe("looking");
  });

  const leaving = ["received", "looking", "fixed", "not_bug", "closed"] as const;
  const leaveCases = statusRoutes.flatMap(([route, post]) => leaving.map((to) => [route, to, post] as const));

  it.each(leaveCases)("redteam-4: %s duplicate -> %s stores duplicate_of NULL in the same change", async (_route, to, post) => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);
    const before = await eventsOf(b.id);

    expect((await post(b.code, { status: to })).status).toBe(200);

    const row = (await reportByCode(b.code))!;
    expect(row.status).toBe(to);
    expect(row.duplicate_of).toBeNull();
    expect(row.verdict).toBe("duplicate");
    const added = await eventsAfter(b, before);
    expect(added.filter((e) => e.type === "status_changed").length, "one status_changed").toBe(1);
    expect(added.filter((e) => e.type === "duplicate_linked"), "no duplicate_linked when leaving").toEqual([]);
  });

  it.each(statusRoutes)("redteam-4: %s after the round trip, B set to duplicate of A (A now points at B) is 409 duplicate_cycle, B unchanged", async (_route, post) => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);
    expect((await post(b.code, { status: "looking" })).status, "B back to looking").toBe(200);
    expect((await linkDuplicate(a.code, b.code)).status, "A -> B").toBe(200);
    const beforeA = await fullSnapshot(a);
    const beforeB = await fullSnapshot(b);

    await expectError(await post(b.code, { status: "duplicate", duplicateOf: a.code }), 409, "duplicate_cycle");

    expect(await fullSnapshot(b), "B unchanged").toEqual(beforeB);
    expect(await fullSnapshot(a), "A unchanged").toEqual(beforeA);
    await expectNoLoopFrom(a.code);
    await expectNoLoopFrom(b.code);
  });

  it.each(statusRoutes)("redteam-4: %s B set to duplicate of a fresh original C: B -> C, events as a triage link, D on B re-pointed to C", async (_route, post) => {
    const c = await seedReport({ status: "looking" });
    const b = await seedReport({ status: "looking", verdict: "needs_person" });
    const d = await seedReport();
    expect((await linkDuplicate(d.code, b.code)).status, "D -> B").toBe(200);
    const beforeB = await eventsOf(b.id);
    const beforeC = await eventsOf(c.id);
    const beforeD = await eventsOf(d.id);

    expect((await post(b.code, { status: "duplicate", duplicateOf: c.code })).status).toBe(200);

    const rowB = (await reportByCode(b.code))!;
    expect(rowB.status).toBe("duplicate");
    expect(rowB.duplicate_of).toBe(c.code);
    expect(rowB.verdict, "the status route never changes verdict").toBe("needs_person");
    const addedB = await eventsAfter(b, beforeB);
    const changes = addedB.filter((e) => e.type === "status_changed");
    expect(changes.length, "B: one status_changed").toBe(1);
    expect(changes[0]!.data).toMatchObject({ from: "looking", to: "duplicate" });
    const linkedB = addedB.filter((e) => e.type === "duplicate_linked");
    expect(linkedB.length, "B: one duplicate_linked").toBe(1);
    expect(linkedB[0]!.data).toEqual({ duplicateOf: c.code });

    const rowD = (await reportByCode(d.code))!;
    expect(rowD.duplicate_of, "D, on B, is re-pointed to the root C").toBe(c.code);
    const linkedD = (await eventsAfter(d, beforeD)).filter((e) => e.type === "duplicate_linked");
    expect(linkedD.length, "D: its own duplicate_linked").toBe(1);
    expect(linkedD[0]!.data).toMatchObject({ duplicateOf: c.code });
    expect(await eventsAfter(c, beforeC), "C, the root, gets no event").toEqual([]);
    expect(await publicStatus(d.code)).toBe("looking");
  });

  it.each(statusRoutes)("redteam-4 (edge): %s B set to duplicate of E, itself a duplicate of C, stores the root C", async (_route, post) => {
    const c = await seedReport({ status: "fixed" });
    const e = await seedReport();
    const b = await seedReport({ status: "looking" });
    expect((await linkDuplicate(e.code, c.code)).status, "E -> C").toBe(200);
    const before = await eventsOf(b.id);

    expect((await post(b.code, { status: "duplicate", duplicateOf: e.code })).status).toBe(200);

    expect((await reportByCode(b.code))!.duplicate_of).toBe(c.code);
    const linked = (await eventsAfter(b, before)).filter((x) => x.type === "duplicate_linked");
    expect(linked.map((x) => x.data)).toEqual([{ duplicateOf: c.code }]);
    expect(await publicStatus(b.code)).toBe("fixed");
  });
});

describe("redteam-4: duplicate by hand needs a valid link (row 2)", () => {
  type Bad = [label: string, payload: (self: ReportRow, other: ReportRow) => Record<string, unknown>];
  const bad: Bad[] = [
    ["duplicate without duplicateOf", () => ({ status: "duplicate" })],
    ["duplicate with duplicateOf null", () => ({ status: "duplicate", duplicateOf: null })],
    ["duplicate with duplicateOf empty", () => ({ status: "duplicate", duplicateOf: "" })],
    ["duplicate with a malformed code", () => ({ status: "duplicate", duplicateOf: "LUM-12" })],
    ["duplicate with a number for a code", () => ({ status: "duplicate", duplicateOf: 482193 })],
    ["duplicate with its own code", (self) => ({ status: "duplicate", duplicateOf: self.code })],
    ["duplicate with a code that does not exist", () => ({ status: "duplicate", duplicateOf: seedCode() })],
    ["fixed with a valid duplicateOf", (_self, other) => ({ status: "fixed", duplicateOf: other.code })],
    ["looking with a valid duplicateOf", (_self, other) => ({ status: "looking", duplicateOf: other.code })],
  ];
  const badCases = statusRoutes.flatMap(([route, post]) => bad.map(([label, payload]) => [route, label, payload, post] as const));

  it.each(badCases)("redteam-4: %s, B looking with no link, %s is 400 invalid_duplicate_of and B is unchanged", async (_route, _label, payload, post) => {
    const b = await seedReport({ status: "looking", verdict: "needs_person", updated_at: Date.now() - DAY });
    const other = await seedReport({ status: "looking" });
    const before = await fullSnapshot(b);
    const beforeOther = await fullSnapshot(other);

    await expectError(await post(b.code, payload(b, other)), 400, "invalid_duplicate_of");

    expect(await fullSnapshot(b), "B: status, link, verdict, updated_at and events as they were").toEqual(before);
    expect(await fullSnapshot(other), "the other report is untouched").toEqual(beforeOther);
  });

  it.each(statusRoutes)("redteam-4 (edge): %s B already duplicate of A, duplicate without duplicateOf is 400 and keeps the link", async (_route, post) => {
    const a = await seedReport({ status: "looking" });
    const b = await seedReport();
    expect((await linkDuplicate(b.code, a.code)).status, "B -> A").toBe(200);
    const before = await fullSnapshot(b);

    await expectError(await post(b.code, { status: "duplicate" }), 400, "invalid_duplicate_of");

    expect(await fullSnapshot(b)).toEqual(before);
    expect(before.duplicate_of).toBe(a.code);
  });
});

describe("redteam-4: retention deletes a report between the triage's read and its write (row 3)", () => {
  it("redteam-4: target B deleted during triage C -> B: 400 invalid_duplicate_of, no event for C or B, C unchanged", async () => {
    const b = await seedReport({ status: "looking" });
    const c = await seedReport();
    const beforeC = await fullSnapshot(c);
    const seq = await maxSeq();
    const { db, fired } = dbWithGapBeforeFirstWrite(() => deleteAsRetention(b));

    const res = await triage(c.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: b.code }, { DB: db });

    expect(fired(), "the triage wrote after its read").toBe(true);
    await expectError(res, 400, "invalid_duplicate_of");
    expect(await eventsSince(seq, [c.id, b.id]), "no event for C, none orphaned on B's id").toEqual([]);
    expect(await fullSnapshot(c), "C unchanged").toEqual(beforeC);
    expect(await reportByCode(b.code), "B stays deleted").toBeNull();
  });

  it("redteam-4: C itself deleted during triage C -> B: 404 not_found, no event on C's id, D still on C and not re-pointed", async () => {
    const b = await seedReport({ status: "looking" });
    const c = await seedReport({ status: "looking" });
    const d = await seedReport();
    expect((await linkDuplicate(d.code, c.code)).status, "D -> C").toBe(200);
    const beforeB = await fullSnapshot(b);
    const beforeD = await fullSnapshot(d);
    const seq = await maxSeq();
    const { db, fired } = dbWithGapBeforeFirstWrite(() => deleteAsRetention(c));

    const res = await triage(c.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: b.code }, { DB: db });

    expect(fired(), "the triage wrote after its read").toBe(true);
    await expectError(res, 404, ERRORS.notFound);
    expect(await eventsSince(seq, [c.id, b.id, d.id]), "no event for C's id, B or D").toEqual([]);
    expect(await reportByCode(c.code), "C stays deleted").toBeNull();
    expect(await fullSnapshot(d), "D still points at C, no duplicate_linked").toEqual(beforeD);
    expect(beforeD.duplicate_of).toBe(c.code);
    expect(await fullSnapshot(b), "B unchanged").toEqual(beforeB);
  });
});

describe("redteam-4: a chain still moving after the two attempts is duplicate_busy (row 4)", () => {
  it("redteam-4: the root moves before every guarded write of C -> A: 409 {error: duplicate_busy, retryAfter: n}, Retry-After n, C unchanged", async () => {
    const a = await seedReport({ status: "looking" });
    const c = await seedReport();
    const beforeC = await fullSnapshot(c);
    const moved: string[] = [];
    // Each gap links the current root of A to a fresh original: the chain grows, never closes a loop.
    const { db, gaps } = dbWithGapBeforeEveryWrite(async () => {
      const root = await storedRoot(a.code);
      const fresh = await seedReport({ status: "looking" });
      expect((await linkDuplicate(root, fresh.code)).status, `move ${root} -> ${fresh.code}`).toBe(200);
      moved.push(fresh.code);
    }, 6);

    const res = await triage(c.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: a.code }, { DB: db });

    expect(gaps(), "both attempts met a moved chain").toBeGreaterThanOrEqual(2);
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b, "the busy answer, not duplicate_cycle").toEqual({ error: "duplicate_busy", retryAfter: expect.any(Number) });
    const n = b.retryAfter as number;
    expect(Number.isInteger(n), `retryAfter ${n} is whole seconds`).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBe(String(n));
    expect(await fullSnapshot(c), "C unchanged, no event").toEqual(beforeC);
    for (const code of [a.code, ...moved]) await expectNoLoopFrom(code);
  });

  it("redteam-4 (edge): after duplicate_busy the same triage, retried on a still chain, is 200 and stores the root", async () => {
    const a = await seedReport({ status: "looking" });
    const c = await seedReport();
    const { db } = dbWithGapBeforeEveryWrite(async () => {
      const root = await storedRoot(a.code);
      const fresh = await seedReport({ status: "looking" });
      expect((await linkDuplicate(root, fresh.code)).status).toBe(200);
    }, 6);
    await expectError(
      await triage(c.code, { verdict: "duplicate", triage: { summary: "same bug" }, duplicateOf: a.code }, { DB: db }),
      409,
      "duplicate_busy",
    );

    expect((await linkDuplicate(c.code, a.code)).status, "the retry").toBe(200);
    const rowC = (await reportByCode(c.code))!;
    expect(rowC.duplicate_of).toBe(await storedRoot(a.code));
    await expectNoLoopFrom(c.code);
  });
});
