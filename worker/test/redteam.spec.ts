// Specs for the red team findings of round 1 (redteam-astra.md, redteam-opus.md) and the lead's fix decisions 1-7
// (brief-fix-rt.md). CONTRACT.md "Limits" (rate, retention), "Statuses", "Game", "Agent and bot", "Desk".
//
// Races are made deterministic with binding doubles passed as env overrides: a D1 or R2 binding that forwards every
// call to the real one and, once, runs another real request in the gap the finding names (between a route's read
// and its write, or between the cron's listing and its delete). Nothing here re-implements a worker rule.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  agentHeaders,
  body,
  call,
  createReport,
  DAY,
  devDeskEnv,
  ERRORS,
  eventTypesOf,
  expectError,
  gameHeaders,
  jsonInit,
  nextIp,
  pattern,
  reportByCode,
  runCron,
  seedAttachment,
  seedReport,
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
