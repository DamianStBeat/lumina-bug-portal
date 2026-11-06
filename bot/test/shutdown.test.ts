// fix round 1, decision 10: at SIGTERM the bot waits for a running event tick (at most 5 s) before
// client.destroy(). main.ts runs at import (it logs in), so no spec can reach its shutdown; the wait is split out as
// `stopThenDestroy(stop, destroy, capMs)` in src/shutdown.ts and main.ts calls it with poller.stop, client.destroy
// and 5000. These specs drive it with a short cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopThenDestroy } from '../src/shutdown.ts';
import { pause } from './fakes/common.ts';

test('fix1-10: destroy runs after stop has resolved', async () => {
  const order: string[] = [];
  await stopThenDestroy(
    async () => {
      await pause(30);
      order.push('stopped');
    },
    async () => {
      order.push('destroyed');
    },
    1000,
  );
  assert.deepEqual(order, ['stopped', 'destroyed']);
});

test('fix1-10: a stop that never ends is waited for capMs only, then destroy runs', async () => {
  let destroyedAt = 0;
  const start = Date.now();
  await stopThenDestroy(
    () => new Promise<void>(() => undefined),
    async () => {
      destroyedAt = Date.now() - start;
    },
    100,
  );
  assert.ok(destroyedAt >= 90, `destroyed after ${destroyedAt} ms, before the cap`);
  assert.ok(destroyedAt < 1000, `destroyed after ${destroyedAt} ms, the cap was not kept`);
});

test('fix1-10: a stop that rejects, or a destroy that rejects, does not stop the shutdown', async () => {
  let destroyed = false;
  await assert.doesNotReject(
    stopThenDestroy(
      async () => {
        throw new Error('tick failed');
      },
      async () => {
        destroyed = true;
        throw new Error('already destroyed');
      },
      100,
    ),
  );
  assert.equal(destroyed, true);
});
