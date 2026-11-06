// Caps the archive copies running at once (fix round 3, decision 17) and stops them at shutdown (decision 22). Each copy
// holds a 16 MiB part buffer (portal.ts) and the service has MemoryMax=300M: without a cap, a handful of players
// sending videos in the same minutes could get the process killed, losing every copy after the players read "We have
// it". The others wait in arrival order.
import { setTimeout as sleep } from 'node:timers/promises';

export type CopyLimiter = {
  /** Starts `job` when a slot is free (FIFO); settles with the job's own result or error. */
  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Shutdown: queued jobs never start (their run rejects with CopyCancelled), running ones get `capMs` to end, then
   * their signal is aborted and they are given a bounded moment to take their failure path.
   */
  drain(capMs: number): Promise<void>;
};

/** A copy that never started because the process is stopping. */
export class CopyCancelled extends Error {
  override name = 'CopyCancelled';
}

// After the abort an upload still makes its best-effort DELETE (worker timeout 15 s). Bounded so that a job ignoring
// its signal cannot hold the shutdown past systemd's 90 s (poller 5 s + drain 20 s + this).
const SETTLE_AFTER_ABORT_MS = 20000;

type Running = { controller: AbortController; done: Promise<void> };

export function createCopyLimiter(max: number): CopyLimiter {
  const running = new Set<Running>();
  const waiting: { start: () => void; cancel: (err: Error) => void }[] = [];
  let draining = false;

  function startNext(): void {
    // start() adds to `running` synchronously, so the loop sees each new slot taken.
    while (!draining && running.size < max && waiting.length > 0) waiting.shift()!.start();
  }

  async function allSettled(capMs: number): Promise<boolean> {
    const all = Promise.all([...running].map((r) => r.done)).then(() => true);
    const timer = new AbortController();
    try {
      return await Promise.race([all, sleep(capMs, false, { signal: timer.signal }).catch(() => false)]);
    } finally {
      timer.abort();
    }
  }

  return {
    run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (draining) return Promise.reject(new CopyCancelled('stopping'));
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          start: () => {
            const entry: Running = { controller: new AbortController(), done: Promise.resolve() };
            running.add(entry);
            entry.done = (async () => {
              try {
                resolve(await job(entry.controller.signal));
              } catch (err) {
                reject(err);
              } finally {
                running.delete(entry);
                startNext();
              }
            })();
          },
          cancel: reject,
        });
        startNext();
      });
    },

    async drain(capMs: number): Promise<void> {
      draining = true;
      for (const w of waiting.splice(0)) w.cancel(new CopyCancelled('stopping'));
      if (running.size === 0) return;
      if (await allSettled(capMs)) return;
      for (const r of running) r.controller.abort();
      await allSettled(SETTLE_AFTER_ABORT_MS);
    },
  };
}

/** The one limiter every archive copy shares (/bug and forum posts); main.ts drains it at shutdown. */
export const copyLimiter: CopyLimiter = createCopyLimiter(2);
