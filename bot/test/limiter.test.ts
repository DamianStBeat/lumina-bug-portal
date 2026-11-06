// fix round 3, decisions 17 and 22: one limiter for every archive copy (/bug and forum posts), at most 2 at once,
// the others in FIFO order; at shutdown it waits for running copies up to a cap, then aborts them.
// Seam (proposed by the test author, fix round 3): src/limiter.ts
//   export type CopyLimiter = {
//     run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>; // starts when a slot is free, FIFO
//     drain(capMs: number): Promise<void>; // waits up to capMs for running jobs, then aborts their signal and
//                                          // resolves once they have settled
//   };
//   export function createCopyLimiter(max: number): CopyLimiter;
//   export const copyLimiter: CopyLimiter; // the shared one, max 2, used when FileDeps.copies is not given
// FileDeps gains an optional `copies?: CopyLimiter`; main.ts drains `copyLimiter` with 20 000 ms at shutdown.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCopyLimiter } from '../src/limiter.ts';
import { handleThreadCreate } from '../src/forumPost.ts';
import { PortalApi } from '../src/portal.ts';
import { AGENT_KEY, FakeWorker, REPORT_TOKEN } from './fakes/worker.ts';
import { cdnUrl, FakeThread, makeMessage, makeUser, type RawAttachment } from './fakes/discord.ts';
import { DISCORD_TOKEN, FORUM_ID, makeConfig, makeLogger, makeTempDir, pause, removeDir } from './fakes/common.ts';

const CODE = 'LUM-482193';
const PLAYER = makeUser('123456789012345678', 'skyler_77');

/** A job the spec ends by hand; records when it started and whether its signal was aborted. */
function manualJob(name: string, started: string[]) {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const state = { aborted: false };
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const job = async (signal: AbortSignal): Promise<string> => {
    started.push(name);
    signal.addEventListener('abort', () => {
      state.aborted = true;
      reject(new Error('aborted'));
    });
    await done;
    return name;
  };
  return { job, finish: () => resolve(), fail: (e: unknown) => reject(e), state };
}

describe('copy limiter', () => {
  test('fix3-17: at most 2 jobs run at once; the third starts when one ends', async () => {
    const l = createCopyLimiter(2);
    const started: string[] = [];
    const [a, b, c] = ['a', 'b', 'c'].map((n) => manualJob(n, started));
    const ra = l.run(a!.job);
    const rb = l.run(b!.job);
    const rc = l.run(c!.job);
    await pause(20);
    assert.deepEqual(started, ['a', 'b'], 'two running, one waiting');
    a!.finish();
    assert.equal(await ra, 'a');
    await pause(20);
    assert.deepEqual(started, ['a', 'b', 'c']);
    b!.finish();
    c!.finish();
    assert.deepEqual(await Promise.all([rb, rc]), ['b', 'c'], 'each run resolves with its own job result');
  });

  test('fix3-17: waiting jobs start in the order they were queued (FIFO)', async () => {
    const l = createCopyLimiter(2);
    const started: string[] = [];
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((n) => manualJob(n, started));
    const runs = jobs.map((j) => l.run(j.job));
    await pause(10);
    for (const j of jobs) {
      j.finish();
      await pause(10);
    }
    await Promise.all(runs);
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  });

  test('fix3-17: a job that fails frees its slot and its run rejects with the same error', async () => {
    const l = createCopyLimiter(1);
    const started: string[] = [];
    const a = manualJob('a', started);
    const b = manualJob('b', started);
    const ra = l.run(a.job);
    const rb = l.run(b.job);
    const boom = new Error('boom');
    a.fail(boom);
    await assert.rejects(ra, (e) => e === boom);
    await pause(10);
    assert.deepEqual(started, ['a', 'b']);
    b.finish();
    assert.equal(await rb, 'b');
  });

  test('fix3-22: drain with nothing running resolves at once', async () => {
    const l = createCopyLimiter(2);
    const t = Date.now();
    await l.drain(1000);
    assert.ok(Date.now() - t < 200);
  });

  test('fix3-22: drain waits for a job that ends within the cap, without aborting it', async () => {
    const l = createCopyLimiter(2);
    const started: string[] = [];
    const a = manualJob('a', started);
    const ra = l.run(a.job);
    await pause(5);
    setTimeout(() => a.finish(), 40);
    const t = Date.now();
    await l.drain(1000);
    const took = Date.now() - t;
    assert.equal(await ra, 'a');
    assert.equal(a.state.aborted, false);
    assert.ok(took >= 30 && took < 500, `drain took ${took} ms`);
  });

  test('fix3-22: drain aborts a job still running at the cap and resolves once it has settled', async () => {
    const l = createCopyLimiter(2);
    const started: string[] = [];
    const a = manualJob('a', started);
    const ra = l.run(a.job).catch((e: unknown) => e);
    await pause(5);
    const t = Date.now();
    await l.drain(100);
    const took = Date.now() - t;
    assert.equal(a.state.aborted, true, 'the signal was aborted');
    assert.ok(took >= 90 && took < 1000, `drain took ${took} ms`);
    assert.ok((await ra) instanceof Error, 'the job ended through its failure path');
  });
});

describe('shutdown with a forum copy in flight', () => {
  let worker: FakeWorker;
  let stateDir: string;
  let log: ReturnType<typeof makeLogger>;

  before(async () => {
    worker = await FakeWorker.start();
    stateDir = await makeTempDir();
  });
  after(async () => {
    await worker.stop();
    await removeDir(stateDir);
  });
  beforeEach(() => {
    worker.requests.length = 0;
    log = makeLogger();
  });
  afterEach(() => {
    const text = log.text();
    for (const secret of [REPORT_TOKEN, AGENT_KEY, DISCORD_TOKEN]) assert.ok(!text.includes(secret), 'secret in logs');
  });

  /**
   * A CDN whose download sends the first half of the file and then stalls; it ends with an error only when the
   * request's signal aborts (as fetch does).
   */
  function stallingCdn(size: number) {
    const calls: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push(input);
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Math.floor(size / 2)));
          const fail = () => controller.error(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(size) } });
    };
    return { fetchImpl, calls };
  }

  test('fix3-22: drain past the cap aborts the copy; the worker sees the attachment DELETE; the handler ends', async () => {
    const img: RawAttachment = { id: '700', name: 'clip.mp4', size: 1000, contentType: 'video/mp4' };
    const cdn = stallingCdn(1000);
    const copies = createCopyLimiter(2);
    const t = new FakeThread('770000000000000700', 'Boss stuck', FORUM_ID, PLAYER.id);
    t.starter = makeMessage({ channelId: t.id, content: 'The boss stopped.', author: PLAYER, attachments: [img] });
    const deps = {
      api: new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs: 2000 }),
      config: makeConfig(worker.base, stateDir),
      log,
      fetchImpl: cdn.fetchImpl,
      copies,
    };
    type Thread = Parameters<typeof handleThreadCreate>[0];
    type Deps = Parameters<typeof handleThreadCreate>[2];
    let handlerDone = false;
    const running = handleThreadCreate(t as unknown as Thread, true, deps as Deps).then(() => (handlerDone = true));

    for (let i = 0; i < 400 && worker.find('POST', `/reports/${CODE}/attachments`).length === 0; i++) await pause(5);
    assert.equal(worker.find('POST', `/reports/${CODE}/attachments`).length, 1, 'the upload started');
    assert.deepEqual(cdn.calls, [cdnUrl(img)]);

    await copies.drain(100);
    await Promise.race([running, pause(1000)]);
    assert.equal(handlerDone, true, 'the handler ended after the abort');
    assert.equal(worker.find('DELETE', /^\/attachments\/[\w-]+$/).length, 1, 'the aborted upload was deleted');
    assert.equal(worker.find('POST', /\/complete$/).length, 0, 'never completed');
  });
});
