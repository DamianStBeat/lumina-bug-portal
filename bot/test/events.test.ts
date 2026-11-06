// design.md "events.ts" and brief rows 5, 6, 7: the poller reads /agent/events and posts into the right thread,
// once, even across a restart (the cursor file lives in a temp dir here, as ~/.local/state/... on Valor1).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CursorStore, EventPoller } from '../src/events.ts';
import { PortalApi } from '../src/portal.ts';
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

type Sent = { threadId: string; message: unknown };
type Posted = { forumId: string; name: string; message: unknown };

/** The small Discord seam of EventPoller: records what was sent; can be told to fail or block a thread. */
function fakeDiscord() {
  const sent: Sent[] = [];
  const posts: Posted[] = [];
  const failThreads = new Set<string>();
  const blocked = new Map<string, Promise<void>>();
  let postSeq = 0;
  return {
    sent,
    posts,
    failThreads,
    blocked,
    seam: {
      async sendToThread(threadId: string, message: unknown): Promise<void> {
        sent.push({ threadId, message });
        const gate = blocked.get(threadId);
        if (gate) await gate;
        if (failThreads.has(threadId)) throw new Error('Unknown Channel');
      },
      async createForumPost(forumId: string, opts: { name: string; message: unknown }): Promise<string> {
        postSeq += 1;
        posts.push({ forumId, name: opts.name, message: opts.message });
        return `78000000000000000${postSeq}`;
      },
    },
  };
}

type Discord = ReturnType<typeof fakeDiscord>;
type PollerOptions = ConstructorParameters<typeof EventPoller>[0];

function poller(file: string, discord: Discord, opts: { base?: string; intervalMs?: number; timeoutMs?: number } = {}) {
  const base = opts.base ?? worker.base;
  const log = makeLogger();
  const p = new EventPoller({
    api: new PortalApi({ base, agentKey: AGENT_KEY, timeoutMs: opts.timeoutMs ?? 2000 }),
    store: new CursorStore(file),
    // The seam is typed by events.ts; the fake records calls only.
    discord: discord.seam as unknown as PollerOptions['discord'],
    config: makeConfig(base, path.dirname(file)),
    log,
    intervalMs: opts.intervalMs ?? 20000,
  });
  return { p, log };
}

function fixedEvent(seq: number, code: string, note = 'The boss now finishes the bridge.') {
  return { seq, code, at: 1_700_000_000_000 + seq, type: 'status_changed', data: JSON.stringify({ status: 'fixed', note }) };
}

function discordReport(code: string, threadId: string | null, extra: Record<string, unknown> = {}) {
  return { code, source: 'discord', status: 'fixed', discord_thread_id: threadId, discord_name: 'skyler_77', ...extra };
}

describe('CursorStore', () => {
  test('design: a missing cursor file reads as 0 (not yet polled)', async () => {
    assert.equal(await new CursorStore(cursorPath()).read(), 0);
  });

  test('design: write then read returns the seq; the directory is created with mode 700', async () => {
    const file = cursorPath();
    const s = new CursorStore(file);
    await s.write(42);
    assert.equal(await new CursorStore(file).read(), 42);
    const mode = (await stat(path.dirname(file))).mode & 0o777;
    assert.equal(mode, 0o700);
  });

  test('design: an unparsable cursor file reads as 0', async () => {
    const file = cursorPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'not a number\n');
    assert.equal(await new CursorStore(file).read(), 0);
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
    const file = cursorPath();
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
    await poller(cursorPath(), d).p.tick();
    assert.equal(d.sent.length, 1);
    assert.equal(readMessage(d.sent[0]!.message).embeds[0]!.title, 'Fixed · LUM-482193');
  });

  test('row 5: status_changed to looking posts nothing; the cursor still advances', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', '770000000000000055', { status: 'looking' }));
    worker.events.push({ seq: 3, code: 'LUM-482193', at: 1, type: 'status_changed', data: { status: 'looking' } });
    const file = cursorPath();
    const d = fakeDiscord();
    await poller(file, d).p.tick();
    assert.equal(d.sent.length, 0);
    assert.equal(await new CursorStore(file).read(), 3);
  });

  test('row 5: fixed for a report with no thread (not yet linked) posts nothing; the cursor advances', async () => {
    worker.reports.set('LUM-482193', discordReport('LUM-482193', null, { source: 'web' }));
    worker.events.push(fixedEvent(4, 'LUM-482193'));
    const file = cursorPath();
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
    await poller(cursorPath(), d).p.tick();
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
    const file = cursorPath();
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
    await poller(cursorPath(), d).p.tick();
    assert.equal(d.posts.length, 0);
  });

  for (const source of ['discord', 'web']) {
    test(`row 6: a ${source} report created event makes no forum post`, async () => {
      worker.reports.set('LUM-333335', {
        code: 'LUM-333335', source, status: 'received', title: 'x', what: 'y', discord_thread_id: null,
      });
      worker.events.push({ seq: 12, code: 'LUM-333335', at: 1, type: 'created', data: {} });
      const d = fakeDiscord();
      await poller(cursorPath(), d).p.tick();
      assert.equal(d.posts.length, 0);
    });
  }

  test('design: other event types are skipped and the cursor advances past them', async () => {
    worker.events.push(
      { seq: 20, code: 'LUM-482193', at: 1, type: 'file_added', data: {} },
      { seq: 21, code: 'LUM-482193', at: 2, type: 'triaged', data: {} },
    );
    const file = cursorPath();
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
    const file = cursorPath();
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
    const file = cursorPath();
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
    const file = cursorPath();
    const d = fakeDiscord();
    d.failThreads.add('770000000000000002');
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
    const file = cursorPath();
    const d = fakeDiscord();
    await poller(file, d, { base: await deadBase() }).p.tick().catch(() => undefined);
    assert.equal(d.sent.length + d.posts.length, 0);
    assert.equal(await new CursorStore(file).read(), 0);
  });

  test('row 7: the report lookup failing mid-batch keeps the event for the next tick', async () => {
    worker.events.push(fixedEvent(30, 'LUM-482193'));
    worker.override = (r) => (r.path.startsWith('/agent/reports/') ? { status: 503, body: { error: 'unavailable' } } : undefined);
    const file = cursorPath();
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
      const { p } = poller(cursorPath(), fakeDiscord(), { intervalMs: 20 });
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
    const { p } = poller(cursorPath(), fakeDiscord(), { intervalMs: 20, timeoutMs: 400 });
    p.start();
    await pause(200);
    assert.equal(worker.find('GET', '/agent/events').length, 1);
    p.stop();
    await pause(450); // let the hung request time out before the next case
  });

  test('design: stop() ends polling', async () => {
    const { p } = poller(cursorPath(), fakeDiscord(), { intervalMs: 20 });
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
