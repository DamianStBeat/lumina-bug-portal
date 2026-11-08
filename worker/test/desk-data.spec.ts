// Damian's row 9 of the integration slice:
//   | 9 | Desk | apro | conteggi delle schede e "Video N MB · Device" come l'anteprima |
// CONTRACT.md "Desk (team only)": the list answer carries `counts` (whole table, the filters' own conditions) and, per
// row, `files` (kind and size of the player's files, oldest first, frames and aborted uploads out). `needs_person` also
// covers a report the agent could not fix (its latest status_changed carries a note beginning `needs_person:`, no PR).
// The agent's and the person's writes go through the worker's own status routes, so the event a spec reads is the one
// the route really stores; the table is seeded only for the columns no route writes on its own (verdict, pr_url).
//
// Run by filter: `cd worker && npx vitest run test/desk-data.spec.ts`.
//
// Mutations (file|old|new|label), on a throwaway prototype of the builder's code (strings there, not on this head): every
// spec below went red under at least one; the counts of red specs per mutation are in done-2b-tests.md.
// worker/src/routes/desk.ts|r.verdict = 'simple_fix' AND r.pr_url IS NOT NULL AND r.status = 'looking'|r.verdict = 'simple_fix' AND r.status = 'looking'|w fix_ready without pr
// worker/src/routes/desk.ts|r.verdict = 'simple_fix' AND r.pr_url IS NOT NULL AND r.status = 'looking'|r.verdict = 'simple_fix' AND r.pr_url IS NOT NULL|w fix_ready not looking
// worker/src/routes/desk.ts|duplicate: "r.status = 'duplicate'"|duplicate: "r.status = 'looking'"|w duplicate condition
// worker/src/routes/desk.ts|not_bug: "r.status = 'not_bug'"|not_bug: "r.verdict = 'not_bug'"|w not_bug by verdict
// worker/src/routes/desk.ts|waiting: "r.status = 'received'"|waiting: "r.verdict IS NULL"|w waiting by verdict
// worker/src/routes/desk.ts|r.status = 'looking' AND r.pr_url IS NULL AND (r.verdict|r.pr_url IS NULL AND (r.verdict|w needs_person not looking
// worker/src/routes/desk.ts|r.status = 'looking' AND r.pr_url IS NULL AND (r.verdict|r.status = 'looking' AND (r.verdict|w needs_person with pr
// worker/src/routes/desk.ts|(r.verdict = 'needs_person' OR (SELECT|((SELECT|w triage needs_person dropped
// worker/src/routes/desk.ts|e.report_id = r.id AND e.type = 'status_changed'|e.type = 'status_changed'|w note of another report
// worker/src/routes/desk.ts|e.report_id = r.id AND e.type = 'status_changed'|e.report_id = r.id|w any event type
// worker/src/routes/desk.ts|ORDER BY e.seq DESC LIMIT 1|ORDER BY e.seq ASC LIMIT 1|w earliest event
// worker/src/routes/desk.ts|substr(json_extract(e.data, '$.note'), 1, 13) END FROM events|json_extract(e.data, '$.note') END FROM events|w whole note compared
// worker/src/routes/desk.ts|LIMIT 1) = 'needs_person:')|LIMIT 1) LIKE 'needs_person:%')|w LIKE
// worker/src/routes/desk.ts|CASE WHEN json_valid(e.data) THEN substr|CASE WHEN 1 THEN substr|w no json_valid
// worker/src/routes/desk.ts|COALESCE(SUM(CASE WHEN ${FILTERS[k]} THEN 1 ELSE 0 END), 0)|SUM(CASE WHEN ${FILTERS[k]} THEN 1 ELSE 0 END)|w null on empty
// worker/src/routes/desk.ts|FROM reports r`).first|FROM reports r WHERE ${FILTERS[filter]}`).first|w counts follow filter
// worker/src/routes/desk.ts|FROM reports r`).first|FROM (SELECT * FROM reports LIMIT 50) r`).first|w counts over page
// worker/src/routes/desk.ts|FROM reports r`).first|FROM reports r LEFT JOIN attachments a ON a.report_id = r.id`).first|w counts multiplied
// worker/src/routes/desk.ts|WHERE ${FILTERS[filter]} ${keyset}|WHERE 1 = 1 ${keyset}|w rows ignore filter
// worker/src/routes/desk.ts|AND f.kind IN ('video', 'image') AND f.status != 'aborted' ORDER BY f.created_at, f.id|AND f.status != 'aborted' ORDER BY f.created_at, f.id|w frames in files
// worker/src/routes/desk.ts|AND f.kind IN ('video', 'image') AND f.status != 'aborted' ORDER BY f.created_at, f.id|AND f.kind IN ('video', 'image') ORDER BY f.created_at, f.id|w aborted in files
// worker/src/routes/desk.ts|AND f.kind IN ('video', 'image') AND f.status != 'aborted' ORDER BY f.created_at, f.id|AND f.kind IN ('video', 'image') AND f.status = 'complete' ORDER BY f.created_at, f.id|w only complete
// worker/src/routes/desk.ts|AND f.status != 'aborted' ORDER BY f.created_at, f.id|AND f.status != 'aborted' ORDER BY f.id|w order by id only
// worker/src/routes/desk.ts|AND f.status != 'aborted' ORDER BY f.created_at, f.id|AND f.status != 'aborted' ORDER BY f.created_at|w no id tie break
// worker/src/routes/desk.ts|ids.map(() => "?")|ids.slice(0, 1).map(() => "?")|w first report only bound slots
// worker/src/routes/desk.ts|.bind(...ids)|.bind(ids[0], ...ids.slice(1).fill(ids[0]))|w files of first report for all
// worker/src/routes/desk.ts|files: filesByReport.get(id) ?? []|files: filesByReport.get(id)|w files undefined when none
// worker/src/routes/desk.ts|{ kind: f.kind, size_bytes: f.size_bytes }]|{ kind: f.kind, size_bytes: f.size_bytes, report_id: f.report_id }]|w extra key leaks in files
// worker/src/routes/desk.ts|CASE WHEN json_valid(e.data) THEN substr|CASE WHEN json_valid(e.data) AND length(json_extract(e.data, '$.note')) > 13 THEN substr|w bare prefix refused
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHeaders,
  body,
  call,
  clearDeskTables,
  devDeskEnv,
  jsonInit,
  seedAttachment,
  seedEvent,
  seedEventData,
  seedReport,
} from "./helpers";

type Filter = "all" | "fix_ready" | "needs_person" | "duplicate" | "not_bug" | "waiting";
type FileLine = { kind: string; size_bytes: number };
type ListedRow = { code: string; files: FileLine[]; attachment_count: number };
type Listed = { reports: ListedRow[]; nextCursor: string | null; counts: Record<Filter, number> };

const FILTERS: Filter[] = ["all", "fix_ready", "needs_person", "duplicate", "not_bug", "waiting"];
const PR = "https://github.com/DamianStBeat/Lumina2/pull/12";
const NOTE = "needs_person: tests_failed"; // the shape agent/lumina_bug_agent/fix.py writes

// Counts are over the whole table: every case starts from an empty one so its expected numbers are its own.
beforeEach(() => clearDeskTables());

async function list(query = ""): Promise<Listed> {
  const res = await call(`/desk/reports${query}`, {}, devDeskEnv);
  expect(res.status).toBe(200);
  return body<Listed>(res);
}
const inFilter = async (filter: Filter) => (await list(`?filter=${filter}`)).reports.map((r) => r.code);
const counts = async () => (await list()).counts;
const rowOf = (l: Listed, code: string) => l.reports.find((r) => r.code === code)!;

// The agent's own write, as fix.py sends it: the route stores the status_changed event the desk must read.
async function agentStatus(code: string, payload: Record<string, unknown>): Promise<void> {
  const res = await call(`/agent/reports/${code}/status`, jsonInit("POST", payload, agentHeaders()));
  expect(res.status).toBe(200);
}
async function personStatus(code: string, payload: Record<string, unknown>): Promise<void> {
  const res = await call(`/desk/reports/${code}/status`, jsonInit("POST", payload), devDeskEnv);
  expect(res.status).toBe(200);
}
// What stage C starts from: triage said simple_fix, the worker stored it as looking, no PR yet.
const simpleFixReport = () => seedReport({ status: "looking", verdict: "simple_fix" });

/** One report per filter condition and per trap around it; returns nothing because each case asserts on the answer. */
async function seedWorld(): Promise<void> {
  const waitingFrames = await seedReport({ status: "received" });
  await seedAttachment(waitingFrames.id, { kind: "frames", filename: "frame-0001.png", mime: "image/png" });
  const waitingAborted = await seedReport({ status: "received" });
  await seedAttachment(waitingAborted.id, { status: "aborted" });
  await seedReport({ status: "looking", verdict: "simple_fix", pr_url: PR });
  await seedReport({ status: "looking", verdict: "needs_person" });
  await seedReport({ status: "duplicate", verdict: "simple_fix", pr_url: PR, duplicate_of: "LUM-000001" });
  await seedReport({ status: "not_bug", verdict: "needs_person" }); // a person's decision wins over triage
  await seedReport({ status: "not_bug", verdict: "not_bug" });
  await seedReport({ status: "closed", verdict: "needs_person" });
  await seedReport({ status: "fixed", verdict: "simple_fix", pr_url: PR });
  await seedReport({ status: "looking", verdict: "simple_fix" }); // no PR and no note: in no tab but All
  await seedReport({ status: "looking" }); // no verdict yet but already looking: waiting is a status, not a verdict
}
const WORLD: Record<Filter, number> = { all: 11, fix_ready: 1, needs_person: 1, duplicate: 1, not_bug: 2, waiting: 2 };

describe("desk list: counts", () => {
  it("row 9: each tab's count over a table that hits every filter condition", async () => {
    await seedWorld();
    expect(await counts()).toEqual(WORLD);
  });

  it("row 9: a count is the rows of that same filter, for every filter", async () => {
    await seedWorld();
    for (const filter of FILTERS) expect((await inFilter(filter)).length, filter).toBe(WORLD[filter]);
    expect((await list()).counts).toEqual(WORLD);
  });

  it("row 9 edge: an empty table counts 0 everywhere, never null", async () => {
    expect(await counts()).toEqual({ all: 0, fix_ready: 0, needs_person: 0, duplicate: 0, not_bug: 0, waiting: 0 });
  });

  it("row 9 edge: frames, an aborted upload and several files do not multiply a report", async () => {
    const r = await seedReport({ status: "received" });
    await seedAttachment(r.id, { kind: "video" });
    await seedAttachment(r.id, { kind: "image", mime: "image/png", filename: "a.png" });
    await seedAttachment(r.id, { status: "aborted" });
    await seedAttachment(r.id, { kind: "frames", mime: "image/png", filename: "frame-0001.png" });
    await seedAttachment(r.id, { kind: "frames", mime: "image/png", filename: "frame-0002.png" });
    expect(await counts()).toEqual({ all: 1, fix_ready: 0, needs_person: 0, duplicate: 0, not_bug: 0, waiting: 1 });
  });

  it("row 9: the same counts whatever filter is asked", async () => {
    await seedWorld();
    for (const filter of FILTERS) expect((await list(`?filter=${filter}`)).counts, filter).toEqual(WORLD);
  });

  it("row 9: the same counts on the next page, over the whole table and not over the page", async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 53; i += 1) await seedReport({ status: "received", created_at: base + i * 1_000 });
    const expected = { all: 53, fix_ready: 0, needs_person: 0, duplicate: 0, not_bug: 0, waiting: 53 };
    const first = await list();
    expect(first.reports).toHaveLength(50);
    expect(first.counts).toEqual(expected);
    const second = await list(`?cursor=${first.nextCursor}`);
    expect(second.reports).toHaveLength(3);
    expect(second.counts).toEqual(expected);
    // A filter with a cursor: still the whole table.
    const filteredFirst = await list("?filter=waiting");
    expect((await list(`?filter=waiting&cursor=${filteredFirst.nextCursor}`)).counts).toEqual(expected);
  });
});

describe("desk list: files per row", () => {
  it("row 9: kind and size exactly, oldest first, frames and aborted uploads out", async () => {
    const r = await seedReport();
    const t = Date.now() - 100_000;
    await seedAttachment(r.id, { kind: "video", size_bytes: 312_000_000, created_at: t + 2_000 });
    await seedAttachment(r.id, { kind: "image", size_bytes: 3_000_000, mime: "image/png", filename: "a.png", created_at: t + 1_000 });
    await seedAttachment(r.id, { kind: "video", size_bytes: 9, status: "aborted", created_at: t });
    await seedAttachment(r.id, { kind: "frames", size_bytes: 8, mime: "image/png", filename: "f.png", created_at: t });
    await seedAttachment(r.id, { kind: "video", size_bytes: 5_000_000, status: "uploading", created_at: t + 3_000 });
    const row = rowOf(await list(), r.code);
    expect(row.files).toEqual([
      { kind: "image", size_bytes: 3_000_000 },
      { kind: "video", size_bytes: 312_000_000 },
      { kind: "video", size_bytes: 5_000_000 },
    ]);
    expect(row.attachment_count).toBe(3);
  });

  it("row 9 edge: two files of the same millisecond come in id order", async () => {
    const r = await seedReport();
    const t = Date.now() - 100_000;
    await seedAttachment(r.id, { id: "file-b", size_bytes: 2, created_at: t });
    await seedAttachment(r.id, { id: "file-a", size_bytes: 1, created_at: t });
    expect(rowOf(await list(), r.code).files).toEqual([
      { kind: "video", size_bytes: 1 },
      { kind: "video", size_bytes: 2 },
    ]);
  });

  it("row 9 edge: a report with no file, with only frames, or with only an aborted upload has []", async () => {
    const none = await seedReport();
    const framesOnly = await seedReport();
    await seedAttachment(framesOnly.id, { kind: "frames", mime: "image/png", filename: "f.png" });
    const abortedOnly = await seedReport();
    await seedAttachment(abortedOnly.id, { status: "aborted" });
    const l = await list();
    for (const code of [none.code, framesOnly.code, abortedOnly.code]) expect(rowOf(l, code).files, code).toEqual([]);
  });

  it("row 9: a `deleted` file stays listed: only an aborted upload leaves (the contract's wording)", async () => {
    const r = await seedReport();
    await seedAttachment(r.id, { size_bytes: 7, status: "deleted" });
    expect(rowOf(await list(), r.code).files).toEqual([{ kind: "video", size_bytes: 7 }]);
  });

  it("row 9: each row has its own files, one report's never reach another", async () => {
    const a = await seedReport();
    const b = await seedReport();
    await seedAttachment(a.id, { size_bytes: 11 });
    await seedAttachment(b.id, { kind: "image", mime: "image/png", filename: "a.png", size_bytes: 22 });
    const l = await list();
    expect(rowOf(l, a.code).files).toEqual([{ kind: "video", size_bytes: 11 }]);
    expect(rowOf(l, b.code).files).toEqual([{ kind: "image", size_bytes: 22 }]);
  });

  it("row 9: a row on the next page and a row under a filter carry their files too", async () => {
    const base = Date.now() - 1_000_000;
    const oldest = await seedReport({ status: "received", created_at: base, what: "oldest one" });
    await seedAttachment(oldest.id, { size_bytes: 33 });
    for (let i = 1; i <= 50; i += 1) await seedReport({ status: "received", created_at: base + i * 1_000 });
    const first = await list();
    const second = await list(`?cursor=${first.nextCursor}`);
    expect(rowOf(second, oldest.code).files).toEqual([{ kind: "video", size_bytes: 33 }]);
    const filtered = await list("?filter=waiting");
    expect(filtered.reports.find((r) => r.code === oldest.code)).toBeUndefined(); // it is on the filter's page 2
    expect(rowOf(await list(`?filter=waiting&cursor=${filtered.nextCursor}`), oldest.code).files).toEqual([{ kind: "video", size_bytes: 33 }]);
  });
});

describe("desk list: needs_person from the agent's note", () => {
  it("row 9: a simple fix the agent could not make, no PR: under needs_person, counted there, not fix_ready", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: NOTE, expectedStatus: "looking" });
    expect(await inFilter("needs_person")).toEqual([r.code]);
    expect(await inFilter("fix_ready")).toEqual([]);
    expect(await counts()).toEqual({ all: 1, fix_ready: 0, needs_person: 1, duplicate: 0, not_bug: 0, waiting: 0 });
  });

  it("row 9 edge: triage's own needs_person is there with no event at all", async () => {
    const r = await seedReport({ status: "looking", verdict: "needs_person" });
    expect(await inFilter("needs_person")).toEqual([r.code]);
  });

  it("row 9: a person's later status change takes it out (fixed)", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: NOTE });
    await personStatus(r.code, { status: "fixed" });
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });

  it("row 9 edge: a person's later status with no note takes it out even while it stays looking (the latest event decides)", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: NOTE });
    await personStatus(r.code, { status: "looking" });
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });

  it("row 9: the agent's later PR link moves it from needs_person to fix_ready", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: NOTE });
    await agentStatus(r.code, { status: "looking", prUrl: PR });
    expect(await inFilter("needs_person")).toEqual([]);
    expect(await inFilter("fix_ready")).toEqual([r.code]);
    expect(await counts()).toMatchObject({ needs_person: 0, fix_ready: 1 });
  });

  it("row 9 edge: a PR already linked keeps it out of needs_person when a later note arrives", async () => {
    const r = await seedReport({ status: "looking", verdict: "simple_fix", pr_url: PR });
    await agentStatus(r.code, { status: "looking", note: NOTE });
    expect(await inFilter("needs_person")).toEqual([]);
    expect(await inFilter("fix_ready")).toEqual([r.code]);
  });

  it("row 9 edge (contract): triage's needs_person with a PR linked is not under needs_person", async () => {
    const r = await seedReport({ status: "looking", verdict: "needs_person", pr_url: PR });
    expect(await inFilter("needs_person")).toEqual([]);
    expect(await counts()).toMatchObject({ needs_person: 0, fix_ready: 0, all: 1 });
  });

  it("row 9 edge: a closed report with the note is not open, so not under needs_person", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "fixed", note: NOTE });
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });

  it("row 9 edge: a later event of another type does not hide the note", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: NOTE });
    await seedEvent(r.id, "file_added");
    expect(await inFilter("needs_person")).toEqual([r.code]);
  });

  it("row 9 edge: a needs_person: text on an event that is not status_changed does not count", async () => {
    const r = await simpleFixReport();
    await seedEventData(r.id, "file_added", JSON.stringify({ note: NOTE }));
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });

  it("row 9 edge: another report's note never counts for this one", async () => {
    const withNote = await simpleFixReport();
    const without = await simpleFixReport();
    await agentStatus(withNote.code, { status: "looking", note: NOTE });
    await agentStatus(without.code, { status: "looking" });
    expect(await inFilter("needs_person")).toEqual([withNote.code]);
    expect((await counts()).needs_person).toBe(1);
  });

  it.each([
    ["no colon", "needs_person"],
    ["another word's prefix", "needs_personal review"],
    ["the prefix in the middle", "was needs_person: before"],
    // SQL LIKE reads `_` as any character: `needs-person:` would match needs_person: there.
    ["a hyphen where the underscore is", "needs-person: agent_failed"],
    // SQL LIKE is case-insensitive: the note is the agent's exact word.
    ["another case", "NEEDS_PERSON: agent_failed"],
  ])("row 9 edge: a note that does not begin with `needs_person:` does not count: %s", async (_label, note) => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note });
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });

  it("row 9 edge: the note may be nothing but the prefix", async () => {
    const r = await simpleFixReport();
    await agentStatus(r.code, { status: "looking", note: "needs_person:" });
    expect(await inFilter("needs_person")).toEqual([r.code]);
  });

  it("row 9 edge: a latest status_changed that is no JSON, or empty, answers 200 and is not a note", async () => {
    const garbage = await simpleFixReport();
    await agentStatus(garbage.code, { status: "looking", note: NOTE });
    await seedEventData(garbage.id, "status_changed", "not json at all");
    const empty = await simpleFixReport();
    await agentStatus(empty.code, { status: "looking", note: NOTE });
    await seedEventData(empty.id, "status_changed", null);
    // One event that does not parse must not take the whole desk down, nor keep a stale note alive.
    expect(await inFilter("needs_person")).toEqual([]);
    expect((await counts()).needs_person).toBe(0);
  });
});
