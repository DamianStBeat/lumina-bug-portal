// The pinned contract as the bot reads it (CONTRACT.md "Agent report shape", "Event data": "Bot and agent read exactly
// these keys; any other key is ignored"), and row 7 of the integration slice: «embed verde nel thread giusto, una volta
// sola». The lead's decision: the bot's flat+nested and two-spellings guessing goes away. The worker here is the
// node:http fake of fakes/worker.ts, serving rows and events in the pinned shapes (and, on purpose, a few outside them).
//
// Run by filter: `cd bot && node --test test/contract.test.ts`.
//
// Mutations (file|old|new|label). Specs marked (green) guard code that exists on 9dfbb0a (each mutation was run in a
// throwaway copy and turned its spec red); the others were red on 9dfbb0a, whose tolerant reading is their first
// mutation, and the line below them describes the builder's code, not yet written.
// bot/src/events.ts|if (typeof status === 'string' && status !== 'fixed') return;|if (typeof status === 'string' && status !== 'looking') return;|k1 (green) agent and desk shapes post
// bot/src/events.ts|status_changed: act only on data.to === 'fixed' (no `status`, no lookup guess)|read `status` / ask the report when `to` is absent (9dfbb0a)|k2 off-contract data ignored
// bot/src/events.ts|if (to !== 'fixed' || typeof from !== 'string' || from === to) return;|if (to !== 'fixed' || from === to) return;|k2 `to: fixed` without `from` (audit 1 finding 5)
// bot/src/portal.ts|getEvents: data used only when it is an object|parse a JSON string (9dfbb0a)|k3 string data ignored
// bot/src/events.ts|status_changed: from === 'fixed' and to === 'fixed' posts nothing|post on every to = fixed (9dfbb0a)|k4 row 7 resend
// bot/src/events.ts|an event at or below the highest seq handled is not handled again|handle every listed event (9dfbb0a)|k5 row 7 same seq twice
// bot/src/events.ts|duplicate_linked: data.duplicateOf only|also data.duplicate_of (9dfbb0a)|k6 snake key ignored
// bot/src/portal.ts|getReport: the flat row only|also body.report (9dfbb0a)|k7 nested row not read
// bot/src/events.ts|const ordered = events.filter((e) => e.seq > cursor).sort((a, b) => a.seq - b.seq);|const ordered = events.sort((a, b) => a.seq - b.seq);|k8 (green) re-served event
// bot/src/events.ts|await this.discord.sendToThread(threadId, sameBug(event.code, original, await this.originalStatus(original)));|return;|k6 (green) duplicateOf posts
// bot/src/events.ts|if (report.source !== 'game' || report.discord_thread_id) return;|if (report.source !== 'web' || report.discord_thread_id) return;|k7 (green) flat row forum post
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CursorStore, EventPoller } from '../src/events.ts';
import { PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, FakeWorker } from './fakes/worker.ts';
import { mentionsNobody, readMessage } from './fakes/discord.ts';
import { FORUM_ID, makeConfig, makeLogger, makeTempDir, removeDir } from './fakes/common.ts';

const CODE = 'LUM-482193';
const ORIGINAL = 'LUM-111111';
const THREAD = '770000000000000055';
const GREEN = 0x5be08e;

let worker: FakeWorker;
let root: string;
let caseNo = 0;

before(async () => {
  worker = await FakeWorker.start();
  root = await makeTempDir();
});
after(async () => {
  await worker.stop();
  await removeDir(root);
});
beforeEach(() => {
  worker.requests.length = 0;
  worker.mode = 'ok';
  worker.override = undefined;
  worker.reports.clear();
  worker.events.length = 0;
});

/** A cursor file holding 0: "polled before, nothing handled yet", so every event is handled from the start. */
function seededCursor(): string {
  caseNo += 1;
  const file = path.join(root, `case-${caseNo}`, 'state', 'cursor');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, '0\n');
  return file;
}

/** Every key of CONTRACT.md "Agent report shape", flat and snake_case, for a discord report with its thread. */
function contractRow(code: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JC8Z6Q4M2V7K9T3N5R1B0XYZ',
    code,
    created_at: 1_762_400_000_000,
    updated_at: 1_762_400_300_000,
    source: 'discord',
    status: 'fixed',
    title: null,
    what: 'The boss stopped on the bridge.',
    where_area: 'match',
    device: null,
    lang: null,
    roblox_name: null,
    roblox_user_id: null,
    discord_user_id: '1301234567890123456',
    discord_name: 'skyler_77',
    discord_thread_id: THREAD,
    game_context: null,
    verdict: 'simple_fix',
    triage: { stage_a: {}, stage_b: {}, files: [], notes: [], agent: 'lumina-bug-agent/1' },
    duplicate_of: null,
    pr_url: 'https://github.com/DamianStBeat/Lumina2/pull/9',
    lease_until: 1_762_403_600_000,
    lease_by: 'valor1-agent',
    attachments: [],
    ...over,
  };
}

type Sent = { threadId: string; message: unknown };

function fakeDiscord() {
  const sent: Sent[] = [];
  const posts: { forumId: string; name: string; message: unknown }[] = [];
  let postSeq = 0;
  return {
    sent,
    posts,
    seam: {
      async sendToThread(threadId: string, message: unknown): Promise<void> {
        sent.push({ threadId, message });
      },
      async createForumPost(forumId: string, opts: { name: string; message: unknown }): Promise<string> {
        posts.push({ forumId, name: opts.name, message: opts.message });
        postSeq += 1;
        return `78000000000000000${postSeq}`;
      },
    },
  };
}

type Discord = ReturnType<typeof fakeDiscord>;
type PollerOptions = ConstructorParameters<typeof EventPoller>[0];

function poller(file: string, d: Discord): EventPoller {
  return new EventPoller({
    api: new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs: 2000 }),
    store: new CursorStore(file),
    // The seam is typed by events.ts; the fake records calls only.
    discord: d.seam as unknown as PollerOptions['discord'],
    config: makeConfig(worker.base, path.dirname(file)),
    log: makeLogger(),
    intervalMs: 20000,
  });
}

function statusEvent(seq: number, data: unknown, code = CODE) {
  return { seq, code, at: 1_762_400_000_000 + seq, type: 'status_changed', data };
}

/** Agent status POST data (CONTRACT.md "Event data"): from, to, note, prUrl, all always. */
function agentData(from: string, to: string, note: string | null = null) {
  return { from, to, note, prUrl: null };
}

const fixedPosts = (d: Discord, code = CODE) =>
  d.sent.filter((s) => readMessage(s.message).embeds[0]?.title === `Fixed · ${code}`);

/** Two ticks, a rejected one included (a transient refusal is retried): what matters is what reached Discord. */
async function twoTicks(p: EventPoller): Promise<void> {
  await p.tick().catch(() => undefined);
  await p.tick().catch(() => undefined);
}

describe('contract: status_changed read by its pinned keys', () => {
  test('k1 (green): the agent shape { from: looking, to: fixed, note, prUrl } posts the green embed in the thread, once', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    worker.events.push(statusEvent(1, agentData('looking', 'fixed', 'The boss now finishes the bridge.')));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).tick();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.threadId, THREAD);
    const m = readMessage(d.sent[0]!.message);
    assert.equal(m.embeds[0]!.title, `Fixed · ${CODE}`);
    assert.equal(m.embeds[0]!.color, GREEN);
    assert.ok((m.embeds[0]!.description ?? '').startsWith('The boss now finishes the bridge.'), m.embeds[0]!.description);
    assert.ok(mentionsNobody(d.sent[0]!.message));
    assert.equal(await new CursorStore(file).read(), 1);
  });

  test('k1 (green): the desk shape { from, to: fixed, note, prUrl, by: desk, email } posts too', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    worker.events.push(statusEvent(1, { from: 'received', to: 'fixed', note: null, prUrl: null, by: 'desk', email: null }));
    const d = fakeDiscord();
    await poller(seededCursor(), d).tick();
    assert.equal(fixedPosts(d).length, 1);
    assert.equal(d.sent[0]!.threadId, THREAD);
  });

  for (const [label, data] of [
    ['only `status: fixed`', { status: 'fixed' }],
    ['`status: fixed` with a note, no from/to', { status: 'fixed', note: 'n' }],
    ['a nested row', { report: contractRow(CODE) }],
    ['`from` without `to`', { from: 'looking', note: null, prUrl: null }],
    ['`to: fixed` without `from`', { to: 'fixed', note: null, prUrl: null }],
    ['an empty object', {}],
    ['null', null],
  ] as const) {
    test(`k2: data outside the contract (${label}) is ignored, not guessed: nothing posted, the stream moves on`, async () => {
      worker.reports.set(CODE, contractRow(CODE)); // the row says fixed: a guess from it would post
      worker.events.push(statusEvent(1, data));
      const file = seededCursor();
      const d = fakeDiscord();
      await poller(file, d).tick();
      assert.equal(d.sent.length, 0, JSON.stringify(d.sent.map((s) => readMessage(s.message).embeds[0]?.title)));
      assert.equal(await new CursorStore(file).read(), 1, 'an ignored event is not retried');
    });
  }

  test('k3: data as a JSON string (the contract says always an object) is not parsed: nothing posted', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    worker.events.push(statusEvent(1, JSON.stringify(agentData('looking', 'fixed', 'n'))));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await new CursorStore(file).read(), 1);
  });
});

describe('contract: row 7, green embed in the right thread, once', () => {
  test('k4: a resend { from: fixed, to: fixed } posts nothing', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    worker.events.push(statusEvent(1, agentData('fixed', 'fixed', 'Shipped again.')));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await new CursorStore(file).read(), 1);
  });

  test('k4: looking -> fixed, then a desk resend fixed -> fixed with a note: exactly one Fixed, the first', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    worker.events.push(
      statusEvent(1, agentData('looking', 'fixed', 'First note.')),
      statusEvent(2, { from: 'fixed', to: 'fixed', note: 'Second note.', prUrl: null, by: 'desk', email: null }),
    );
    const d = fakeDiscord();
    await poller(seededCursor(), d).tick();
    assert.equal(fixedPosts(d).length, 1);
    assert.equal(d.sent.length, 1);
    assert.ok((readMessage(d.sent[0]!.message).embeds[0]!.description ?? '').startsWith('First note.'));
  });

  test('k5: the same event seq listed twice in one page posts once', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    const e = statusEvent(7, agentData('looking', 'fixed'));
    worker.events.push(e, { ...e });
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).tick();
    assert.equal(fixedPosts(d).length, 1);
    assert.equal(await new CursorStore(file).read(), 7);
  });

  test('k8 (green): a worker that serves the same event again on the next tick gets no second post', async () => {
    worker.reports.set(CODE, contractRow(CODE));
    const e = statusEvent(7, agentData('looking', 'fixed'));
    worker.override = (r) =>
      r.method === 'GET' && r.path === '/agent/events' ? { status: 200, body: { events: [e], last: 7 } } : undefined;
    const d = fakeDiscord();
    const p = poller(seededCursor(), d);
    await p.tick();
    await p.tick();
    assert.equal(fixedPosts(d).length, 1);
  });
});

describe('contract: duplicate_linked and the report row, pinned keys only', () => {
  test('k6 (green): duplicate_linked { duplicateOf } posts Same bug naming the original', async () => {
    worker.reports.set(CODE, contractRow(CODE, { status: 'duplicate', duplicate_of: ORIGINAL }));
    worker.reports.set(ORIGINAL, contractRow(ORIGINAL, { status: 'looking', discord_thread_id: '770000000000000011' }));
    worker.events.push({ seq: 1, code: CODE, at: 1, type: 'duplicate_linked', data: { duplicateOf: ORIGINAL } });
    const d = fakeDiscord();
    await poller(seededCursor(), d).tick();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.threadId, THREAD);
    assert.equal(readMessage(d.sent[0]!.message).embeds[0]!.description, `This is the same as ${ORIGINAL}. Thanks for telling us.`);
  });

  test('k6: duplicate_linked with only `duplicate_of` (not a pinned key) names nothing: nothing posted', async () => {
    worker.reports.set(CODE, contractRow(CODE, { status: 'duplicate', duplicate_of: null }));
    worker.reports.set(ORIGINAL, contractRow(ORIGINAL, { status: 'fixed' }));
    worker.events.push({ seq: 1, code: CODE, at: 1, type: 'duplicate_linked', data: { duplicate_of: ORIGINAL } });
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await new CursorStore(file).read(), 1);
  });

  test('k7: a report answer nested under `report` is not read as the row: no Fixed posted', async () => {
    worker.override = (r) =>
      r.method === 'GET' && r.path === `/agent/reports/${CODE}`
        ? { status: 200, body: { report: contractRow(CODE), attachments: [] } }
        : undefined;
    worker.events.push(statusEvent(1, agentData('looking', 'fixed')));
    const d = fakeDiscord();
    await twoTicks(poller(seededCursor(), d));
    assert.equal(d.sent.length, 0);
  });

  test('k7: a game report answered nested under `report` gets no forum post', async () => {
    const game = contractRow(CODE, { source: 'game', status: 'received', title: 'Boss stuck', discord_thread_id: null, discord_user_id: null, discord_name: null });
    worker.override = (r) =>
      r.method === 'GET' && r.path === `/agent/reports/${CODE}` ? { status: 200, body: { report: game, attachments: [] } } : undefined;
    worker.events.push({ seq: 1, code: CODE, at: 1, type: 'created', data: { source: 'game' } });
    const d = fakeDiscord();
    await twoTicks(poller(seededCursor(), d));
    assert.equal(d.posts.length, 0);
  });

  test('k7: PortalApi.getReport refuses a nested answer (bad_response) and returns the flat row as sent', async () => {
    const api = new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs: 2000 });
    worker.override = (r) =>
      r.method === 'GET' && r.path === `/agent/reports/${CODE}`
        ? { status: 200, body: { report: contractRow(CODE), attachments: [] } }
        : undefined;
    await assert.rejects(api.getReport(CODE), (err: unknown) => err instanceof PortalError && err.code === 'bad_response');
    worker.override = undefined;
    worker.reports.set(CODE, contractRow(CODE));
    assert.deepEqual(await api.getReport(CODE), contractRow(CODE));
  });

  test('k7 (green): the flat row with every pinned key and game_context an object makes the forum post', async () => {
    worker.reports.set(CODE, contractRow(CODE, {
      source: 'game', status: 'received', title: 'Boss stuck', discord_thread_id: null, discord_user_id: null,
      discord_name: null, roblox_user_id: 123456789, roblox_name: 'PlayerOne',
      game_context: { placeId: 1, map: 'Bridge', wave: 12, device: 'phone' },
    }));
    worker.events.push({ seq: 1, code: CODE, at: 1, type: 'created', data: { source: 'game' } });
    const d = fakeDiscord();
    await poller(seededCursor(), d).tick();
    assert.equal(d.posts.length, 1);
    assert.equal(d.posts[0]!.forumId, FORUM_ID);
    assert.match(readMessage(d.posts[0]!.message).content ?? '', /"wave": 12/);
  });
});
