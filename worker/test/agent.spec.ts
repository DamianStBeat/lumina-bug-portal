// Agent and bot API (acceptance rows 13-16). CONTRACT.md "HTTP API" > Agent and bot.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  agentHeaders,
  body,
  call,
  ERRORS,
  eventTypesOf,
  expectError,
  jsonInit,
  MINUTE,
  reportByCode,
  seedAttachment,
  seedEvent,
  seedReport,
  SHAPES,
} from "./helpers";

// Queue order is oldest first; specs that look at the queue seed reports from the dawn of time so they sit on the
// first page whatever else this file created.
let ancient = 1_000;
function ancientTime(): number {
  ancient += 1_000;
  return ancient;
}

async function queueCodes(): Promise<string[]> {
  const res = await call("/agent/queue?limit=50", { headers: agentHeaders() });
  expect(res.status).toBe(200);
  const b = await body<Record<string, { code: string }[]>>(res);
  const list = b[SHAPES.queueListField];
  expect(Array.isArray(list), `queue answer has a "${SHAPES.queueListField}" array`).toBe(true);
  return list!.map((r) => r.code);
}

function claim(code: string, by: string, minutes: number): Promise<Response> {
  return call(`/agent/reports/${code}/claim`, jsonInit("POST", { by, minutes }, agentHeaders()));
}

describe("agent auth", () => {
  it.each([
    ["no Authorization header", {} as Record<string, string>],
    ["a wrong bearer key", { Authorization: "Bearer wrong-agent-key-not-a-secret" }],
    ["the key without the Bearer scheme", null],
  ])("contract: %s on an agent route gives 401", async (_label, headers) => {
    const h = headers ?? { Authorization: env.AGENT_KEY };
    await expectError(await call("/agent/queue", { headers: h }), 401);
  });
});

describe("POST /agent/reports/{code}/claim", () => {
  it("row 13: two agents claim the same code, the second gets 409 leased", async () => {
    const r = await seedReport();
    const first = await claim(r.code, "agent-a", 10);
    expect(first.status).toBe(200);
    const { leaseUntil } = await body<{ leaseUntil: number }>(first);

    await expectError(await claim(r.code, "agent-b", 10), 409, ERRORS.leased);

    const row = await reportByCode(r.code);
    expect(row!.lease_by).toBe("agent-a");
    expect(leaseUntil).toBe(row!.lease_until);
    expect(Math.abs(row!.lease_until! - (Date.now() + 10 * MINUTE))).toBeLessThan(MINUTE);
  });

  it("row 13 (edge): an expired lease does not block a new claim", async () => {
    const r = await seedReport({ lease_by: "agent-old", lease_until: Date.now() - 1_000 });
    expect((await claim(r.code, "agent-b", 5)).status).toBe(200);
    expect((await reportByCode(r.code))!.lease_by).toBe("agent-b");
  });
});

describe("GET /agent/queue", () => {
  it("row 14: a report with an upload started 5 minutes ago is held back; after 30 minutes it is in the queue", async () => {
    const r = await seedReport({ created_at: ancientTime() });
    const a = await seedAttachment(r.id, { status: "uploading", created_at: Date.now() - 5 * MINUTE, upload_id: "u-1" });
    expect(await queueCodes()).not.toContain(r.code);

    await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 29 * MINUTE, a.id)
      .run();
    expect(await queueCodes()).not.toContain(r.code);

    await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 30 * MINUTE - 1_000, a.id)
      .run();
    expect(await queueCodes()).toContain(r.code);
  });

  it("row 14 (edge): a completed fresh upload does not hold the report back", async () => {
    const r = await seedReport({ created_at: ancientTime() });
    await seedAttachment(r.id, { status: "complete", created_at: Date.now() - MINUTE, completed_at: Date.now() });
    expect(await queueCodes()).toContain(r.code);
  });

  it("row 14 (edge): only received reports without a live lease, oldest first", async () => {
    const older = await seedReport({ created_at: ancientTime() });
    const newer = await seedReport({ created_at: ancientTime() });
    const leased = await seedReport({ created_at: ancientTime(), lease_by: "agent-a", lease_until: Date.now() + 10 * MINUTE });
    const expired = await seedReport({ created_at: ancientTime(), lease_by: "agent-a", lease_until: Date.now() - MINUTE });
    const looking = await seedReport({ created_at: ancientTime(), status: "looking" });

    const codes = await queueCodes();
    expect(codes).toContain(older.code);
    expect(codes).toContain(newer.code);
    expect(codes.indexOf(older.code)).toBeLessThan(codes.indexOf(newer.code));
    expect(codes).toContain(expired.code);
    expect(codes).not.toContain(leased.code);
    expect(codes).not.toContain(looking.code);
  });
});

describe("POST /agent/reports/{code}/triage", () => {
  it("row 15: triage duplicate with duplicateOf stores the link and appends triaged and duplicate_linked", async () => {
    const original = await seedReport({ status: "looking" });
    const r = await seedReport();
    const triage = { summary: "Same freeze as the original", confidence: 0.9 };

    const res = await call(
      `/agent/reports/${r.code}/triage`,
      jsonInit("POST", { verdict: "duplicate", triage, duplicateOf: original.code }, agentHeaders()),
    );

    expect(res.status).toBe(200);
    const row = await reportByCode(r.code);
    expect(row!.status).toBe("duplicate");
    expect(row!.duplicate_of).toBe(original.code);
    expect(row!.verdict).toBe("duplicate");
    expect(JSON.parse(row!.triage!)).toEqual(triage);
    const types = await eventTypesOf(r.id);
    expect(types).toContain("triaged");
    expect(types).toContain("duplicate_linked");
  });

  it.each([
    ["simple_fix", "looking"],
    ["not_bug", "not_bug"],
  ])("contract: triage verdict %s sets status %s and links nothing", async (verdict, status) => {
    const r = await seedReport();
    const res = await call(
      `/agent/reports/${r.code}/triage`,
      jsonInit("POST", { verdict, triage: { summary: "checked" } }, agentHeaders()),
    );
    expect(res.status).toBe(200);
    const row = await reportByCode(r.code);
    expect(row!.status).toBe(status);
    expect(row!.verdict).toBe(verdict);
    expect(row!.duplicate_of).toBeNull();
    const types = await eventTypesOf(r.id);
    expect(types).toContain("triaged");
    expect(types).not.toContain("duplicate_linked");
  });
});

describe("GET /agent/events", () => {
  type EventsAnswer = { events: { seq: number; code: string; at: number; type: string }[]; last: number };

  async function events(query: string): Promise<EventsAnswer> {
    const res = await call(`/agent/events?${query}`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    return body<EventsAnswer>(res);
  }

  it("row 16: after=10 returns only seq > 10, ascending, and last is the highest seq returned", async () => {
    const r = await seedReport();
    for (let i = 0; i < 20; i++) await seedEvent(r.id, i % 2 ? "status_changed" : "created");
    const low = await env.DB.prepare("SELECT count(*) AS n FROM events WHERE seq <= 10").first<{ n: number }>();
    expect(low!.n, "there are events at or below seq 10 to leave out").toBeGreaterThan(0);
    const expected = await env.DB.prepare("SELECT seq FROM events WHERE seq > 10 ORDER BY seq LIMIT 5").all<{
      seq: number;
    }>();

    const page = await events("after=10&limit=5");

    expect(page.events.map((e) => e.seq)).toEqual(expected.results.map((e) => e.seq));
    expect(page.last).toBe(expected.results[4]!.seq);
    for (const e of page.events.filter((x) => x.seq > 10 && x.code === r.code)) {
      expect(["created", "status_changed"]).toContain(e.type);
    }

    const all = await events("after=10");
    const seqs = all.events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(0);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(10);
      if (i > 0) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(all.last).toBe(seqs[seqs.length - 1]);
    expect(all.events.filter((e) => e.code === r.code).length).toBeGreaterThan(0);
  });

  it("row 16 (edge): after the highest seq there are no events", async () => {
    const max = await env.DB.prepare("SELECT max(seq) AS m FROM events").first<{ m: number | null }>();
    const page = await events(`after=${max!.m ?? 0}`);
    expect(page.events).toEqual([]);
  });
});
