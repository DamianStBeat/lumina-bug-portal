// design.md "events.ts" and brief rows 5, 6, 7: the poller reads /agent/events and posts into the right thread,
// once, even across a restart (the cursor file lives in a temp dir here, as ~/.local/state/... on Valor1).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiscordAPIError, HTTPError } from 'discord.js';
import { CursorStore, EventPoller } from '../src/events.ts';
import { errorTag, PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, deadBase, FakeWorker } from './fakes/worker.ts';
import { mentionsNobody, readMessage } from './fakes/discord.ts';
import { FORUM_ID, makeConfig, makeLogger, makeTempDir, pause, removeDir } from './fakes/common.ts';

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

/** A fresh state dir per case; the cursor file is `<dir>/cursor`. */
function cursorPath(): string {
  caseNo += 1;
  return path.join(root, `case-${caseNo}`, 'state', 'cursor');
}

/**
 * A fresh cursor file that already holds 0 ("polled before, nothing handled yet"). Since fix round 1 (decision 8)
 * a missing file fast-forwards, so the cases that expect events to be handled from the start begin here.
 */
function seededCursor(value = 0): string {
  const file = cursorPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${value}\n`);
  return file;
}

/** The number in the cursor file, or undefined when there is no file. */
async function cursorValue(file: string): Promise<number | undefined> {
  try {
    return Number((await readFile(file, 'utf8')).trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** A REST error as discord.js throws it for a Discord 4xx (numeric code, HTTP status). */
function discordError(code: number, status: number): DiscordAPIError {
  return new DiscordAPIError({ code, message: `error ${code}` }, code, status, 'POST', `/channels/x/messages`, {
    body: undefined,
    files: undefined,
  });
}

/** A Discord 5xx after discord.js's own retries: transient. */
function discord5xx(status = 503): HTTPError {
  return new HTTPError(status, 'Service Unavailable', 'POST', '/channels/x/messages', { body: undefined, files: undefined });
}

type Sent = { threadId: string; message: unknown };
type Posted = { forumId: string; name: string; message: unknown };

/** The small Discord seam of EventPoller: records what was sent; can be told to fail or block a thread. */
function fakeDiscord() {
  const sent: Sent[] = [];
  const posts: Posted[] = [];
  /** Thread id -> the error its send rejects with. */
  const failThreads = new Map<string, Error>();
  /** When set, createForumPost rejects with it. */
  const failPost: { error: Error | null } = { error: null };
  const blocked = new Map<string, Promise<void>>();
  let postSeq = 0;
  return {
    sent,
    posts,
    failThreads,
    blocked,
    failPost,
    seam: {
      async sendToThread(threadId: string, message: unknown): Promise<void> {
        sent.push({ threadId, message });
        const gate = blocked.get(threadId);
        if (gate) await gate;
        const err = failThreads.get(threadId);
        if (err) throw err;
      },
      async createForumPost(forumId: string, opts: { name: string; message: unknown }): Promise<string> {
        posts.push({ forumId, name: opts.name, message: opts.message });
        if (failPost.error) throw failPost.error;
        postSeq += 1;
        return `78000000000000000${postSeq}`;
      },
    },
  };
}

type Discord = ReturnType<typeof fakeDiscord>;
type PollerOptions = ConstructorParameters<typeof EventPoller>[0];

function poller(
  file: string,
  discord: Discord,
  opts: {
    base?: string;
    intervalMs?: number;
    timeoutMs?: number;
    replay?: boolean;
    store?: CursorStore;
    now?: () => number;
  } = {},
) {
  const base = opts.base ?? worker.base;
  const log = makeLogger();
  const config = makeConfig(base, path.dirname(file));
  const p = new EventPoller({
    api: new PortalApi({ base, agentKey: AGENT_KEY, timeoutMs: opts.timeoutMs ?? 2000 }),
    store: opts.store ?? new CursorStore(file),
    // The seam is typed by events.ts; the fake records calls only.
    discord: discord.seam as unknown as PollerOptions['discord'],
    // Decision 8: LUMINA_BOT_REPLAY reaches the poller through config.replay (loadConfig, see config.test.ts).
    config: opts.replay === undefined ? config : Object.assign(config, { replay: opts.replay }),
    log,
    intervalMs: opts.intervalMs ?? 20000,
    // Decision 15: the clock that measures the 6 h retry window (default Date.now).
    now: opts.now ?? Date.now,
  });
  return { p, log };
}

function fixedEvent(seq: number, code: string, note = 'The boss now finishes the bridge.') {
  // The worker's own shape (routes/agent.ts, desk.ts): `{ from, to, note, prUrl }`, stored as JSON text.
  return {
    seq,
    code,
    at: 1_700_000_000_000 + seq,
    type: 'status_changed',
    data: JSON.stringify({ from: 'looking', to: 'fixed', note, prUrl: null }),
  };
}

function discordReport(code: string, threadId: string | null, extra: Record<string, unknown> = {}) {
  return { code, source: 'discord', status: 'fixed', discord_thread_id: threadId, discord_name: 'skyler_77', ...extra };
}

describe('CursorStore', () => {
  test('design: write then read returns the seq; the directory is created with mode 700', async () => {
    const file = cursorPath();
    const s = new CursorStore(file);
    await s.write(42);
    assert.equal(await new CursorStore(file).read(), 42);
    const mode = (await stat(path.dirname(file))).mode & 0o777;
    assert.equal(mode, 0o700);
  });

  test('design: the write is atomic (no temp file left beside the cursor)', async () => {
    const file = cursorPath();
    const s = new CursorStore(file);
    await s.write(1);
    await s.write(2);
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)]);
    assert.match(await readFile(file, 'utf8'), /^\s*2\s*$/);
  });
});

describe('EventPoller.tick', () => {
  test('row 5: fixed for a code with a thread -> green embed in that thread, once, even after a restart', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055'));
    worker.events.push(fixedEvent(7, 'LUM-482193'));
    const file = seededCursor();
    const d = fakeDiscord();
    const first = poller(file, d).p;

    await first.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.threadId, '770000000000000055');
    const m = readMessage(d.sent[0]!.message);
    assert.equal(m.embeds[0]!.title, 'Fixed · LUM-482193');
    assert.equal(
      m.embeds[0]!.description,
      "The boss now finishes the bridge. It is in the game from today's update. Thanks, skyler\\_77.",
    );
    assert.equal(m.embeds[0]!.color, 0x5be08e);
    assert.ok(mentionsNobody(d.sent[0]!.message));
    assert.equal(await new CursorStore(file).read(), 7);

    // Same poller again: nothing new.
    await first.tick();
    // Restart: a new store and poller on the same cursor file.
    const d2 = fakeDiscord();
    await poller(file, d2).p.tick();
    assert.equal(d.sent.length, 1, 'not repeated');
    assert.equal(d2.sent.length, 0, 'not repeated after a restart');
    const polls = worker.find('GET', '/agent/events');
    assert.equal(polls[polls.length - 1]!.query.get('after'), '7');
  });

  test('row 5: status_changed with no status in data asks the report, and posts when it is fixed', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055'));
    worker.events.push({ seq: 1, code: 'LUM-482193', at: 1, type: 'status_changed', data: null });
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(readMessage(d.sent[0]!.message).embeds[0]!.title, 'Fixed · LUM-482193');
  });

  test('row 5: status_changed to looking posts nothing; the cursor still advances', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055', { status: 'looking' }));
    worker.events.push({ seq: 3, code: 'LUM-482193', at: 1, type: 'status_changed', data: { from: 'received', to: 'looking' } });
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await new CursorStore(file).read(), 3);
  });

  test('row 5: fixed for a report with no thread (not yet linked) posts nothing; the cursor advances', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', null, { source: 'web' }));
    worker.events.push(fixedEvent(4, 'LUM-482193'));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(d.posts.length, 0);
    assert.equal(await new CursorStore(file).read(), 4);
  });

  test('design: duplicate_linked -> grey "Same bug" in the thread, naming the original', async () => {
    worker.reports.set('LUM-482540', discordReport('LUM-482540', '770000000000000066', { status: 'duplicate', duplicate_of: 'LUM-482193' }));
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055', { status: 'fixed' }));
    worker.events.push({ seq: 5, code: 'LUM-482540', at: 1, type: 'duplicate_linked', data: { duplicateOf: 'LUM-482193' } });
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.threadId, '770000000000000066');
    const m = readMessage(d.sent[0]!.message);
    assert.equal(m.embeds[0]!.title, 'Same bug · LUM-482540');
    assert.equal(m.embeds[0]!.description, 'This is the same as LUM-482193, which is fixed. Thanks for telling us.');
    assert.equal(m.embeds[0]!.color, 0x949ba4);
    assert.ok(mentionsNobody(d.sent[0]!.message));
  });

  test('row 6: a game report with no thread -> new forum post "Bug report: <title>" with the context, then linked', async () => {
    worker.reports.set('LUM-333333', {
      code: 'LUM-333333',
      source: 'game',
      status: 'received',
      title: 'Boss stuck on bridge',
      what: 'The boss stopped on the bridge and the wave never ended.',
      game_context: JSON.stringify({ placeId: 1, map: 'Bridge', wave: 12, device: 'phone' }),
      discord_thread_id: null,
    });
    worker.events.push({ seq: 10, code: 'LUM-333333', at: 1, type: 'created', data: { source: 'game' } });
    const file = seededCursor();
    const d = fakeDiscord();

    await poller(file, d).p.tick();
    assert.equal(d.posts.length, 1);
    assert.equal(d.posts[0]!.forumId, FORUM_ID);
    assert.equal(d.posts[0]!.name, 'Bug report: Boss stuck on bridge');
    const content = readMessage(d.posts[0]!.message).content ?? '';
    assert.ok(content.includes('The boss stopped on the bridge and the wave never ended.'), content);
    assert.ok(content.includes('```json'), content);
    assert.match(content, /"wave": 12/);
    assert.ok(mentionsNobody(d.posts[0]!.message));
    const links = worker.find('POST', '/agent/reports/LUM-333333/discord');
    assert.equal(links.length, 1);
    assert.deepEqual(links[0]!.json, { threadId: '780000000000000001' });
    assert.equal(await new CursorStore(file).read(), 10);

    // Restart: the same event is not posted twice.
    const d2 = fakeDiscord();
    await poller(file, d2).p.tick();
    assert.equal(d2.posts.length, 0);
  });

  test('row 6: a game report that already has a thread gets no second post', async () => {
    worker.reports.set('LUM-333334', {
      code: 'LUM-333334', source: 'game', status: 'received', title: 'x', what: 'y', game_context: '{}',
      discord_thread_id: '770000000000000077',
    });
    worker.events.push({ seq: 11, code: 'LUM-333334', at: 1, type: 'created', data: {} });
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.posts.length, 0);
  });

  for (const source of ['discord', 'web']) {
    test(`row 6: a ${source} report created event makes no forum post`, async () => {
      worker.reports.set('LUM-333335', {
        code: 'LUM-333335', source, status: 'received', title: 'x', what: 'y', discord_thread_id: null,
      });
      worker.events.push({ seq: 12, code: 'LUM-333335', at: 1, type: 'created', data: {} });
      const d = fakeDiscord();
      await poller(seededCursor(), d).p.tick();
      assert.equal(d.posts.length, 0);
    });
  }

  test('design: other event types are skipped and the cursor advances past them', async () => {
    worker.events.push(
      { seq: 20, code: 'LUM-482193', at: 1, type: 'file_added', data: {} },
      { seq: 21, code: 'LUM-482193', at: 2, type: 'triaged', data: {} },
    );
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length + d.posts.length, 0);
    assert.equal(await new CursorStore(file).read(), 21);
  });

  test('design: events are handled in seq order even when the worker lists them out of order', async () => {
    worker.reports.set('LUM-000001', discordReport('LUM-000001', '770000000000000001'));
    worker.reports.set('LUM-000002', discordReport('LUM-000002', '770000000000000002'));
    worker.override = (r) =>
      r.path === '/agent/events'
        ? {
            status: 200,
            body: { events: [fixedEvent(9, 'LUM-000002'), fixedEvent(8, 'LUM-000001')], last: 9 },
          }
        : undefined;
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.deepEqual(
      d.sent.map((s) => s.threadId),
      ['770000000000000001', '770000000000000002'],
    );
    assert.equal(await new CursorStore(file).read(), 9);
  });

  test('row 5: the cursor is written after each event (a crash mid-batch repeats nothing already posted)', async () => {
    for (const n of [1, 2, 3]) {
      worker.reports.set(`LUM-00000${n}`, discordReport(`LUM-00000${n}`, `77000000000000000${n}`));
      worker.events.push(fixedEvent(n, `LUM-00000${n}`));
    }
    const file = seededCursor();
    const d = fakeDiscord();
    let release!: () => void;
    d.blocked.set('770000000000000002', new Promise<void>((r) => (release = r)));

    const running = poller(file, d).p.tick();
    // Wait until the second post is in flight, then look at the file as a crash would leave it.
    for (let i = 0; i < 200 && d.sent.length < 2; i++) await pause(5);
    assert.equal(d.sent.length, 2);
    assert.equal(await new CursorStore(file).read(), 1, 'event 1 is recorded before event 2 is posted');
    release();
    await running;
    assert.equal(await new CursorStore(file).read(), 3);
  });

  test('row 5: a failed post stops the batch; the next tick retries it and never repeats the earlier one', async () => {
    for (const n of [1, 2, 3]) {
      worker.reports.set(`LUM-00000${n}`, discordReport(`LUM-00000${n}`, `77000000000000000${n}`));
      worker.events.push(fixedEvent(n, `LUM-00000${n}`));
    }
    const file = seededCursor();
    const d = fakeDiscord();
    d.failThreads.set('770000000000000002', discord5xx());
    await poller(file, d).p.tick().catch(() => undefined);
    assert.deepEqual(
      d.sent.map((s) => s.threadId),
      ['770000000000000001', '770000000000000002'],
      'event 3 waits behind the failed one',
    );
    assert.equal(await new CursorStore(file).read(), 1);

    d.failThreads.clear();
    await poller(file, d).p.tick();
    assert.deepEqual(
      d.sent.map((s) => s.threadId),
      ['770000000000000001', '770000000000000002', '770000000000000002', '770000000000000003'],
    );
    assert.equal(await new CursorStore(file).read(), 3);
  });

  test('row 7: worker unreachable -> nothing posted, the cursor untouched', async () => {
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d, { base: await deadBase() }).p.tick().catch(() => undefined);
    assert.equal(d.sent.length + d.posts.length, 0);
    assert.equal(await new CursorStore(file).read(), 0);
  });

  test('row 7: the report lookup failing mid-batch keeps the event for the next tick', async () => {
    worker.events.push(fixedEvent(30, 'LUM-482193'));
    worker.override = (r) => (r.path.startsWith('/agent/reports/') ? { status: 503, body: { error: 'unavailable' } } : undefined);
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick().catch(() => undefined);
    assert.equal(await new CursorStore(file).read(), 0, 'not skipped: retried next tick');
    worker.override = undefined;
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055'));
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(await new CursorStore(file).read(), 30);
  });
});

describe('EventPoller.start/stop', () => {
  test('row 7: with the worker failing, the poller keeps polling and nothing escapes as an unhandled error', async () => {
    const escaped: unknown[] = [];
    const onEscape = (e: unknown) => escaped.push(e);
    process.on('unhandledRejection', onEscape);
    process.on('uncaughtException', onEscape);
    try {
      worker.mode = 'error';
      const { p } = poller(seededCursor(), fakeDiscord(), { intervalMs: 20 });
      p.start();
      await pause(250);
      p.stop();
      await pause(50);
      assert.ok(worker.find('GET', '/agent/events').length >= 2, 'still polling after a failure');
      assert.deepEqual(escaped, []);
    } finally {
      process.off('unhandledRejection', onEscape);
      process.off('uncaughtException', onEscape);
    }
  });

  test('design: never two ticks at once (a slow worker is not polled again until it answers)', async () => {
    worker.mode = 'hang';
    const { p } = poller(seededCursor(), fakeDiscord(), { intervalMs: 20, timeoutMs: 400 });
    p.start();
    await pause(200);
    assert.equal(worker.find('GET', '/agent/events').length, 1);
    p.stop();
    await pause(450); // let the hung request time out before the next case
  });

  test('design: stop() ends polling', async () => {
    const { p } = poller(seededCursor(), fakeDiscord(), { intervalMs: 20 });
    p.start();
    await pause(100);
    p.stop();
    await pause(30);
    const count = worker.find('GET', '/agent/events').length;
    assert.ok(count >= 1);
    await pause(150);
    assert.equal(worker.find('GET', '/agent/events').length, count);
  });
});

// ---------------------------------------------------------------- fix round 1

/** The values of a log line's data: the keys are the builder's, the specs look for what the line carries. */
function hasLine(log: ReturnType<typeof makeLogger>, level: 'info' | 'warn' | 'error', values: unknown[]): boolean {
  return log.lines.some((l) => {
    if (l.level !== level || !l.data || typeof l.data !== 'object') return false;
    const v = Object.values(l.data as Record<string, unknown>);
    return values.every((x) => v.includes(x));
  });
}

const T1 = '770000000000000001';
const T2 = '770000000000000002';

/** Event 1 (code LUM-000001, thread T1) and event 2 (LUM-000002, thread T2): both "fixed", both with a thread. */
function twoFixedEvents(): void {
  worker.reports.set('LUM-000001', discordReport('LUM-000001', T1));
  worker.reports.set('LUM-000002', discordReport('LUM-000002', T2));
  worker.events.push(fixedEvent(1, 'LUM-000001'), fixedEvent(2, 'LUM-000002'));
}

const sentTo = (d: Discord, threadId: string) => d.sent.filter((s) => s.threadId === threadId).length;

describe('fix round 1: poison events (decision 3)', () => {
  for (const [label, code, status] of [
    ['10003 Unknown Channel', 10003, 404],
    ['10008 Unknown Message', 10008, 404],
    ['50001 Missing Access', 50001, 403],
    ['50013 Missing Permissions', 50013, 403],
    ['50083 thread archived', 50083, 400],
    ['50035 another 4xx (Invalid Form Body)', 50035, 400],
    ['40005 another 4xx (413 too large)', 40005, 413],
  ] as const) {
    test(`fix1-3: Discord ${label} on a thread is permanent: skipped, logged, the next event posts`, async () => {
      twoFixedEvents();
      const file = seededCursor();
      const d = fakeDiscord();
      const err = discordError(code, status);
      d.failThreads.set(T1, err);
      const { p, log } = poller(file, d);
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T2), 1, 'the event after it is posted in the same tick');
      assert.equal(await cursorValue(file), 2);
      assert.ok(hasLine(log, 'warn', [1, 'LUM-000001', 'status_changed', errorTag(err)]), log.text());
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T1), 1, 'never tried again');
      assert.equal(sentTo(d, T2), 1, 'never posted twice');
    });
  }

  for (const [label, code] of [
    ['40067 tag required', 40067],
    ['40058 forum tag rule', 40058],
  ] as const) {
    test(`fix1-3: Discord ${label} on a game report post is permanent: skipped, nothing linked, the next event posts`, async () => {
      worker.reports.set('LUM-333333', {
        code: 'LUM-333333', source: 'game', status: 'received', title: 'Boss stuck', what: 'w', discord_thread_id: null,
      });
      worker.reports.set('LUM-000002', discordReport('LUM-000002', T2));
      worker.events.push({ seq: 1, code: 'LUM-333333', at: 1, type: 'created', data: { source: 'game' } }, fixedEvent(2, 'LUM-000002'));
      const file = seededCursor();
      const d = fakeDiscord();
      const err = discordError(code, 400);
      d.failPost.error = err;
      const { p, log } = poller(file, d);
      await p.tick().catch(() => undefined);
      assert.equal(d.posts.length, 1);
      assert.equal(worker.find('POST', '/agent/reports/LUM-333333/discord').length, 0);
      assert.equal(sentTo(d, T2), 1);
      assert.equal(await cursorValue(file), 2);
      assert.ok(hasLine(log, 'warn', [1, 'LUM-333333', 'created', errorTag(err)]), log.text());
    });
  }

  for (const type of ['status_changed', 'duplicate_linked', 'created'] as const) {
    test(`fix1-3: a worker 404 on the report of a ${type} event is permanent: skipped, the next event posts`, async () => {
      worker.reports.set('LUM-000002', discordReport('LUM-000002', T2));
      const data = type === 'status_changed' ? { from: 'looking', to: 'fixed' } : type === 'duplicate_linked' ? { duplicateOf: 'LUM-000002' } : {};
      worker.events.push({ seq: 1, code: 'LUM-404404', at: 1, type, data }, fixedEvent(2, 'LUM-000002'));
      const file = seededCursor();
      const d = fakeDiscord();
      const { p, log } = poller(file, d);
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T2), 1);
      assert.equal(await cursorValue(file), 2);
      assert.ok(hasLine(log, 'warn', [1, 'LUM-404404', type, errorTag(new PortalError('not_found', 404))]), log.text());
    });
  }

  for (const [label, make] of [
    ['Discord 5xx', () => discord5xx(503)],
    ['Discord 429', () => discordError(0, 429)],
    ['a network error', () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ] as const) {
    test(`fix1-3: ${label} is transient: the batch stops there, the next tick posts it once`, async () => {
      twoFixedEvents();
      const file = seededCursor();
      const d = fakeDiscord();
      d.failThreads.set(T1, make());
      const { p } = poller(file, d);
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T2), 0, 'order kept: event 2 waits');
      assert.equal(await cursorValue(file), 0);
      d.failThreads.clear();
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T1), 2, 'one failed attempt, one post');
      assert.equal(sentTo(d, T2), 1);
      assert.equal(await cursorValue(file), 2);
    });
  }

  for (const [label, reply] of [
    ['503', { status: 503, body: { error: 'unavailable' } }],
    ['429', { status: 429, body: { error: 'rate_limited' } }],
  ] as const) {
    test(`fix1-3: a worker ${label} on the report is transient: kept for the next tick`, async () => {
      twoFixedEvents();
      const file = seededCursor();
      const d = fakeDiscord();
      worker.override = (r) => (r.path === '/agent/reports/LUM-000001' ? reply : undefined);
      const { p } = poller(file, d);
      await p.tick().catch(() => undefined);
      assert.equal(d.sent.length, 0);
      assert.equal(await cursorValue(file), 0);
      worker.override = undefined;
      await p.tick().catch(() => undefined);
      assert.equal(sentTo(d, T1), 1);
      assert.equal(sentTo(d, T2), 1);
    });
  }

  // Decision 15 (fix round 2): a transient failure is retried every tick until 6 hours have passed since its first
  // failure, measured with the poller's `now()`; only then is it skipped with an error log.
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const T0 = 1_800_000_000_000;

  /** A clock the spec moves by hand. */
  function fakeClock(start = T0) {
    const c = { t: start, now: () => c.t };
    return c;
  }

  test('fix2-15: a Discord transient failure is retried at every tick up to 5h59m, then skipped at 6h with an error log', async () => {
    twoFixedEvents();
    const file = seededCursor();
    const d = fakeDiscord();
    d.failThreads.set(T1, discord5xx(503));
    const clock = fakeClock();
    const { p, log } = poller(file, d, { now: clock.now });
    // 12 ticks between the first failure and 5h59m: far more than any attempt count, all still retried.
    const offsets = [0, 1, 2, 5, 10, 30, 60, 120, 180, 240, 300, 359].map((m) => m * MIN);
    for (const off of offsets) {
      clock.t = T0 + off;
      await p.tick().catch(() => undefined);
    }
    assert.equal(sentTo(d, T1), offsets.length, 'tried at every tick');
    assert.equal(sentTo(d, T2), 0, 'order kept: event 2 waits behind it');
    assert.equal(await cursorValue(file), 0);
    assert.ok(!log.lines.some((l) => l.level === 'error'), log.text());

    clock.t = T0 + 6 * HOUR;
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T2), 1, 'skipped at 6h: the stream moves on, once');
    assert.equal(await cursorValue(file), 2);
    assert.ok(hasLine(log, 'error', [1, 'LUM-000001']), log.text());
    clock.t = T0 + 7 * HOUR;
    await p.tick().catch(() => undefined);
    assert.ok(sentTo(d, T1) <= offsets.length + 1, 'not tried again after the skip');
    assert.equal(sentTo(d, T2), 1);
  });

  test('fix2-15: a transient failure that clears at 5h59m posts the event once, no error log', async () => {
    twoFixedEvents();
    const file = seededCursor();
    const d = fakeDiscord();
    d.failThreads.set(T1, discord5xx(502));
    const clock = fakeClock();
    const { p, log } = poller(file, d, { now: clock.now });
    for (let n = 0; n < 8; n++) {
      clock.t = T0 + n * 45 * MIN; // 0 .. 5h15m, 8 failed ticks
      await p.tick().catch(() => undefined);
    }
    d.failThreads.clear();
    clock.t = T0 + 6 * HOUR - MIN;
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T1), 9, 'eight failures and the post');
    assert.equal(sentTo(d, T2), 1);
    assert.equal(await cursorValue(file), 2);
    assert.ok(!log.lines.some((l) => l.level === 'error'), log.text());
  });

  test('fix2-15: the 6h count from the first failure, not from when the poller started', async () => {
    const file = seededCursor();
    const d = fakeDiscord();
    const clock = fakeClock();
    const { p } = poller(file, d, { now: clock.now });
    await p.tick(); // nothing to do yet
    clock.t = T0 + 10 * HOUR;
    twoFixedEvents();
    d.failThreads.set(T1, discord5xx(503));
    for (const m of [0, 60, 120, 180, 240, 300, 359]) {
      clock.t = T0 + 10 * HOUR + m * MIN;
      await p.tick().catch(() => undefined);
    }
    assert.equal(sentTo(d, T2), 0, 'still within 6h of its first failure');
    clock.t = T0 + 16 * HOUR;
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T2), 1);
  });

  test('fix2-15: a restart resets the window (the event is retried again, never lost)', async () => {
    twoFixedEvents();
    const file = seededCursor();
    const d = fakeDiscord();
    d.failThreads.set(T1, discord5xx(503));
    const clock = fakeClock();
    const first = poller(file, d, { now: clock.now }).p;
    for (const m of [0, 120, 359]) {
      clock.t = T0 + m * MIN;
      await first.tick().catch(() => undefined);
    }
    // Restart at 7h: a new process, a new first failure.
    const second = poller(file, d, { now: clock.now }).p;
    for (const h of [7, 8, 9, 10, 11, 12, 12.9]) {
      clock.t = T0 + h * HOUR;
      await second.tick().catch(() => undefined);
    }
    assert.equal(sentTo(d, T2), 0, 'retried after the restart, not skipped');
    assert.equal(await cursorValue(file), 0);
    clock.t = T0 + 13 * HOUR;
    await second.tick().catch(() => undefined);
    assert.equal(sentTo(d, T2), 1, '6h after the new first failure: skipped');
  });

  test('fix2-15: a permanent refusal is still skipped at once, whatever the clock', async () => {
    twoFixedEvents();
    const file = seededCursor();
    const d = fakeDiscord();
    d.failThreads.set(T1, discordError(50013, 403));
    const clock = fakeClock();
    const { p } = poller(file, d, { now: clock.now });
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T1), 1);
    assert.equal(sentTo(d, T2), 1);
    assert.equal(await cursorValue(file), 2);
  });

  test('fix2-15: a worker transient failure on the report is retried up to 5h59m, skipped at 6h', async () => {
    twoFixedEvents();
    const file = seededCursor();
    const d = fakeDiscord();
    worker.override = (r) => (r.path === '/agent/reports/LUM-000001' ? { status: 503, body: { error: 'unavailable' } } : undefined);
    const clock = fakeClock();
    const { p, log } = poller(file, d, { now: clock.now });
    const offsets = [0, 30, 60, 90, 120, 180, 240, 300, 359].map((m) => m * MIN);
    for (const off of offsets) {
      clock.t = T0 + off;
      await p.tick().catch(() => undefined);
    }
    assert.equal(worker.find('GET', '/agent/reports/LUM-000001').length, offsets.length);
    assert.equal(sentTo(d, T2), 0);
    clock.t = T0 + 6 * HOUR;
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T2), 1);
    assert.equal(await cursorValue(file), 2);
    assert.ok(hasLine(log, 'error', [1, 'LUM-000001']), log.text());
  });
});

describe('fix round 1: cursor write failure (decision 4)', () => {
  /** A cursor store on a state dir that cannot be written (EACCES): reads work, every write rejects. */
  class UnwritableStore extends CursorStore {
    override async write(_seq: number): Promise<void> {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
  }

  test('fix1-4: a cursor that cannot be written never makes the same process post an event twice', async () => {
    worker.reports.set('LUM-000001', discordReport('LUM-000001', T1));
    worker.reports.set('LUM-000002', discordReport('LUM-000002', T2));
    worker.events.push(fixedEvent(1, 'LUM-000001'));
    const file = seededCursor();
    const d = fakeDiscord();
    const { p, log } = poller(file, d, { store: new UnwritableStore(file) });
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T1), 1);
    assert.ok(log.lines.some((l) => l.level === 'error'), 'the failed write is logged at error');
    await p.tick().catch(() => undefined);
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T1), 1, 'not posted again');

    // A newer event is still handled, once.
    worker.events.push(fixedEvent(2, 'LUM-000002'));
    await p.tick().catch(() => undefined);
    await p.tick().catch(() => undefined);
    assert.equal(sentTo(d, T1), 1);
    assert.equal(sentTo(d, T2), 1);
  });
});

describe('fix round 1: report and event shapes (decision 6)', () => {
  test('fix1-6: a nested { report, attachments } answer is read like the flat row', async () => {
    worker.override = (r) =>
      r.method === 'GET' && r.path === '/agent/reports/LUM-482193'
        ? { status: 200, body: { report: discordReport('LUM-482193', '770000000000000055'), attachments: [] } }
        : undefined;
    worker.events.push(fixedEvent(1, 'LUM-482193'));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.threadId, '770000000000000055');
    const m = readMessage(d.sent[0]!.message);
    assert.equal(m.embeds[0]!.title, 'Fixed · LUM-482193');
    assert.ok((m.embeds[0]!.description ?? '').includes('Thanks, skyler\\_77.'), m.embeds[0]!.description);
    assert.equal(await cursorValue(file), 1);
  });

  test('fix1-6: duplicate_linked with duplicate_of (snake case) in the event data names the original', async () => {
    worker.reports.set('LUM-482540', discordReport('LUM-482540', '770000000000000066', { status: 'duplicate', duplicate_of: null }));
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055', { status: 'fixed' }));
    worker.events.push({ seq: 5, code: 'LUM-482540', at: 1, type: 'duplicate_linked', data: { duplicate_of: 'LUM-482193' } });
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(
      readMessage(d.sent[0]!.message).embeds[0]!.description,
      'This is the same as LUM-482193, which is fixed. Thanks for telling us.',
    );
  });

  test('fix1-6: duplicate_linked with duplicateOf (camel case) in the event data names the original', async () => {
    worker.reports.set('LUM-482540', discordReport('LUM-482540', '770000000000000066', { status: 'duplicate', duplicate_of: null }));
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055', { status: 'looking' }));
    worker.events.push({ seq: 5, code: 'LUM-482540', at: 1, type: 'duplicate_linked', data: { duplicateOf: 'LUM-482193' } });
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(readMessage(d.sent[0]!.message).embeds[0]!.description, 'This is the same as LUM-482193. Thanks for telling us.');
  });
});

describe('fix round 1: missing cursor (decision 8)', () => {
  function fixedEvents(from: number, to: number): void {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055'));
    for (let n = from; n <= to; n++) worker.events.push(fixedEvent(n, 'LUM-482193'));
  }

  test('fix1-8: no cursor file -> fast-forward over every page, nothing handled, cursor written, warn logged', async () => {
    fixedEvents(1, 120); // more than one page of 50
    const file = cursorPath();
    const d = fakeDiscord();
    const { p, log } = poller(file, d);
    await p.tick();
    assert.equal(d.sent.length + d.posts.length, 0, 'nothing posted');
    assert.equal(worker.find('GET', /^\/agent\/reports\//).length, 0, 'no event handled');
    assert.equal(await cursorValue(file), 120);
    assert.ok(log.lines.some((l) => l.level === 'warn'), log.text());

    // From there on, a new event is handled once.
    fixedEvents(121, 121);
    await p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(await cursorValue(file), 121);
  });

  test('fix1-8: no cursor file and no events yet -> the cursor is written, so the first event later is posted', async () => {
    const file = cursorPath();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await cursorValue(file), 0, 'the file exists now ("polled, nothing yet")');
    fixedEvents(1, 1);
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 1);
  });

  test('fix1-8: worker down during the fast-forward -> no cursor written, nothing handled; the next tick fast-forwards', async () => {
    fixedEvents(1, 3);
    const file = cursorPath();
    const d = fakeDiscord();
    worker.mode = 'error';
    await poller(file, d).p.tick().catch(() => undefined);
    assert.equal(await cursorValue(file), undefined, 'still "never polled"');
    worker.mode = 'ok';
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await cursorValue(file), 3);
  });

  test('fix1-8: an unparsable cursor file -> error log and fast-forward', async () => {
    fixedEvents(1, 3);
    const file = cursorPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'not a number\n');
    const d = fakeDiscord();
    const { p, log } = poller(file, d);
    await p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await cursorValue(file), 3);
    assert.ok(log.lines.some((l) => l.level === 'error'), log.text());
  });

  test('fix1-8: no cursor file with replay on -> every event from 0 is handled', async () => {
    fixedEvents(1, 3);
    const file = cursorPath();
    const d = fakeDiscord();
    await poller(file, d, { replay: true }).p.tick();
    assert.equal(d.sent.length, 3);
    assert.equal(await cursorValue(file), 3);
  });

  test('fix1-8: a cursor file holding 0 is a real cursor, not a missing one: events are handled', async () => {
    fixedEvents(1, 2);
    const file = seededCursor(0);
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 2);
    assert.equal(await cursorValue(file), 2);
  });
});

describe('fix round 1: stop waits for the running tick (decision 10)', () => {
  test('fix1-10: stop() during a tick returns a promise that resolves only when the tick has ended', async () => {
    worker.reports.set('LUM-000001', discordReport('LUM-000001', T1));
    worker.events.push(fixedEvent(1, 'LUM-000001'));
    const file = seededCursor();
    const d = fakeDiscord();
    let release!: () => void;
    d.blocked.set(T1, new Promise<void>((r) => (release = r)));
    const { p } = poller(file, d, { intervalMs: 20 });
    p.start();
    for (let i = 0; i < 200 && d.sent.length < 1; i++) await pause(5);
    assert.equal(d.sent.length, 1, 'the tick is posting');

    const stopped: unknown = p.stop();
    assert.ok(stopped instanceof Promise, 'stop() returns a promise');
    let done = false;
    void stopped.then(() => (done = true));
    await pause(50);
    assert.equal(done, false, 'not resolved while the tick runs');
    release();
    await stopped;
    assert.equal(await cursorValue(file), 1, 'the tick wrote its cursor before stop() resolved');
    await pause(60);
    assert.equal(worker.find('GET', '/agent/events').length, 1, 'no tick after stop');
  });

  test('fix1-10: stop() with no tick running resolves at once', async () => {
    const { p } = poller(seededCursor(), fakeDiscord(), { intervalMs: 10_000 });
    const idle: unknown = p.stop();
    assert.ok(idle instanceof Promise, 'stop() before start returns a promise');
    await idle;
    p.start();
    await pause(50); // the first tick (empty) ends
    const again: unknown = p.stop();
    assert.ok(again instanceof Promise);
    let done = false;
    void again.then(() => (done = true));
    await pause(20);
    assert.equal(done, true);
  });
});

describe('fix round 1: status_changed data as the worker writes it (decision 12)', () => {
  const THREAD = '770000000000000055';
  const statusEvent = (seq: number, data: unknown) => ({ seq, code: 'LUM-482193', at: seq, type: 'status_changed', data });
  const fixedTitles = (d: Discord) =>
    d.sent.filter((s) => readMessage(s.message).embeds[0]?.title === 'Fixed · LUM-482193').length;

  test('fix1-12: to "looking" posts nothing and asks nothing, even when the report is fixed by now', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'fixed' }));
    worker.events.push(statusEvent(1, { from: 'received', to: 'looking', note: null, prUrl: null }));
    const file = seededCursor();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(worker.find('GET', /^\/agent\/reports\//).length, 0, 'no lookup: the data says the status');
    assert.equal(await cursorValue(file), 1);
  });

  test('fix1-12: looking then fixed -> exactly one "Fixed", with the note of the fixed event', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'fixed' }));
    worker.events.push(
      statusEvent(1, { from: 'received', to: 'looking' }),
      statusEvent(2, { from: 'looking', to: 'fixed', note: 'The boss now finishes the bridge.', prUrl: 'https://github.com/x/y/pull/1' }),
    );
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(fixedTitles(d), 1);
    assert.ok((readMessage(d.sent[0]!.message).embeds[0]!.description ?? '').startsWith('The boss now finishes the bridge.'));
  });

  test('fix1-12: to "fixed" posts even when the report has moved on since (the event decides, not the row)', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'closed' }));
    worker.events.push(statusEvent(1, { from: 'looking', to: 'fixed' }));
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(fixedTitles(d), 1);
    assert.equal(d.sent[0]!.threadId, THREAD);
  });

  test('fix1-12: to wins over status when both are present', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'fixed' }));
    worker.events.push(statusEvent(1, { to: 'looking', status: 'fixed' }));
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(d.sent.length, 0);
  });

  test('fix1-12: status alone is still read (tolerance): fixed posts, looking does not', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'fixed' }));
    worker.events.push(statusEvent(1, { status: 'looking' }), statusEvent(2, { status: 'fixed', note: 'n' }));
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(fixedTitles(d), 1);
  });

  test('fix1-12: neither to nor status ("not said", not "not fixed") -> the report is asked, and posts when fixed', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', THREAD, { status: 'fixed' }));
    worker.events.push(statusEvent(1, { from: 'looking' }));
    const d = fakeDiscord();
    await poller(seededCursor(), d).p.tick();
    assert.equal(fixedTitles(d), 1);
    assert.ok(worker.find('GET', '/agent/reports/LUM-482193').length >= 1);
  });
});

describe('fix round 1: events of removed reports (decision 13)', () => {
  test('fix1-13: a code null event is skipped, the page is read, the next event posts, the cursor moves past both', async () => {
    worker.reports.set('LUM-000002', discordReport('LUM-000002', T2));
    worker.events.push(
      { seq: 1, code: null, at: 1, type: 'status_changed', data: JSON.stringify({ from: 'looking', to: 'fixed' }) },
      fixedEvent(2, 'LUM-000002'),
    );
    const file = seededCursor();
    const d = fakeDiscord();
    const { p, log } = poller(file, d);
    await assert.doesNotReject(p.tick());
    assert.equal(sentTo(d, T2), 1);
    assert.equal(d.sent.length, 1);
    assert.equal(await cursorValue(file), 2);
    assert.equal(worker.find('GET', /^\/agent\/reports\/(null|undefined)?$/).length, 0, 'no lookup without a code');
    assert.ok(!log.text().includes('bad_response'), log.text());
  });

  for (const type of ['created', 'duplicate_linked', 'status_changed'] as const) {
    test(`fix1-13: a page holding only a code null ${type} event advances the cursor and posts nothing`, async () => {
      worker.events.push({ seq: 7, code: null, at: 1, type, data: {} });
      const file = seededCursor();
      const d = fakeDiscord();
      await poller(file, d).p.tick();
      assert.equal(d.sent.length + d.posts.length, 0);
      assert.equal(await cursorValue(file), 7);
    });
  }

  test('fix1-13: a code null event during the fast-forward does not stop it', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055'));
    worker.events.push(fixedEvent(1, 'LUM-482193'), { seq: 2, code: null, at: 2, type: 'created', data: {} }, fixedEvent(3, 'LUM-482193'));
    const file = cursorPath(); // missing: fast-forward (decision 8)
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await cursorValue(file), 3);
  });
});

