// fix round 3, decision 17: archive copies from /bug and from forum posts share one limiter, at most 2 at once,
// the others waiting in FIFO order. This file uses the shared default limiter (no `copies` in deps), so it runs
// alone in its own process (node --test isolates files) and every copy it starts is released before it ends.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBugModalSubmit } from '../src/bugCommand.ts';
import { handleThreadCreate } from '../src/forumPost.ts';
import { PortalApi } from '../src/portal.ts';
import { patternBytes } from './fakes/cdn.ts';
import { AGENT_KEY, FakeWorker } from './fakes/worker.ts';
import {
  cdnUrl,
  FakeForum,
  FakeThread,
  makeMessage,
  makeUser,
  modalInteraction,
  type RawAttachment,
} from './fakes/discord.ts';
import { FORUM_ID, makeConfig, makeLogger, makeTempDir, pause, removeDir } from './fakes/common.ts';

const PLAYER = makeUser('123456789012345678', 'skyler_77');
let worker: FakeWorker;
let stateDir: string;

before(async () => {
  worker = await FakeWorker.start();
  stateDir = await makeTempDir();
});
after(async () => {
  await worker.stop();
  await removeDir(stateDir);
});

/** A CDN where each download waits until the spec releases its URL; records the order downloads started. */
function gatedCdn() {
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  const gate = (url: string) => {
    if (!waits.has(url)) waits.set(url, new Promise<void>((r) => gates.set(url, r)));
    return waits.get(url)!;
  };
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    await gate(input);
    return new Response(patternBytes(100), { status: 200, headers: { 'content-length': '100' } });
  };
  const release = (url: string) => {
    void gate(url);
    gates.get(url)!();
  };
  return { fetchImpl, calls, release };
}

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  for (let t = 0; t < ms && !cond(); t += 5) await pause(5);
  return cond();
}

test('fix3-17: /bug and forum copies share 2 slots; the waiting ones start in arrival order', async () => {
  const cdn = gatedCdn();
  const deps = {
    api: new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs: 2000 }),
    config: makeConfig(worker.base, stateDir),
    log: makeLogger(),
    fetchImpl: cdn.fetchImpl,
  };
  const file = (id: string): RawAttachment => ({ id, name: `f${id}.png`, size: 100, contentType: 'image/png' });
  type Interaction = Parameters<typeof handleBugModalSubmit>[0];
  type Thread = Parameters<typeof handleThreadCreate>[0];

  const runs: Promise<unknown>[] = [];
  // A: /bug. Its copy begins right after the player's answer.
  const a = modalInteraction({ user: PLAYER, forum: new FakeForum(), what: 'A', file: file('801'), attachmentSizeLimit: 1 });
  runs.push(handleBugModalSubmit(a as unknown as Interaction, deps));
  assert.ok(await until(() => a.finalAnswer() !== undefined && cdn.calls.length === 1), 'A copying');

  // B, C, D: forum posts, each started once the previous one has reached its copy (the thread reply comes first).
  const threads: FakeThread[] = [];
  for (const [n, id] of [['B', '802'], ['C', '803'], ['D', '804']] as const) {
    const t = new FakeThread(`77000000000000080${threads.length}`, n, FORUM_ID, PLAYER.id);
    t.starter = makeMessage({ channelId: t.id, content: n, author: PLAYER, attachments: [file(id)] });
    threads.push(t);
    runs.push(handleThreadCreate(t as unknown as Thread, true, deps));
    assert.ok(await until(() => t.sent.length === 1), `${n} answered`);
    await pause(20);
  }

  assert.deepEqual(cdn.calls, [cdnUrl(file('801')), cdnUrl(file('802'))], 'two copies at once, C and D wait');

  cdn.release(cdnUrl(file('801')));
  assert.ok(await until(() => cdn.calls.length === 3));
  await pause(20);
  assert.equal(cdn.calls[2], cdnUrl(file('803')), 'C before D (FIFO)');
  assert.equal(cdn.calls.length, 3, 'still two at once');

  for (const id of ['802', '803']) cdn.release(cdnUrl(file(id)));
  assert.ok(await until(() => cdn.calls.length === 4));
  cdn.release(cdnUrl(file('804')));
  await Promise.all(runs);
  assert.equal(worker.find('POST', /\/complete$/).length, 4, 'every copy completed in the end');
});
