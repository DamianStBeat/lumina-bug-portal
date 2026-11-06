// Follows the worker's event log and tells Discord what changed (brief rows 5 and 6). The cursor is written after
// every handled event, so a restart never posts one twice. A transient failure stops the batch (order matters) for at
// most RETRY_WINDOW_MS from its first failure; a permanent one, or one past that window, skips the event so the stream
// behind it moves on.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiscordAPIError } from 'discord.js';
import type { Config, Logger } from './config.ts';
import {
  errorTag,
  type PortalApi,
  PortalError,
  type PortalEvent,
  type PublicStatus,
  type ReportRow,
  toPublicStatus,
} from './portal.ts';
import { type BotMessage, fixed, gameReportPost, sameBug } from './text.ts';

// Measured in time, not ticks (fix round 2, decision 15): a Discord or worker outage longer than a few ticks must not
// cost a player their "Fixed" post, while an event that never succeeds must still stop blocking the stream one day.
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
// A /bug report is created before its forum post exists and is linked after it (bugCommand.ts): an event arriving in
// between finds no thread yet. Past this age a missing thread is taken as "never coming" (fix round 3, decision 21).
const LINK_GRACE_MS = 10 * 60 * 1000;

/** A discord report whose thread link may still be on its way: transient, so the event is retried. */
class ThreadNotLinkedYet extends Error {
  override name = 'ThreadNotLinkedYet';
}

/** "missing" is "never polled here" and "unparsable" a damaged file: neither is a cursor of 0. */
export type CursorState = number | 'missing' | 'unparsable';

type CodedEvent = PortalEvent & { code: string };

/**
 * A refusal that the same event would get on every retry. Worker: the report is gone (404). Discord: every 4xx but a
 * rate limit (10003 Unknown Channel, 10008 Unknown Message, 50001 Missing Access, 50013 Missing Permissions, 50083
 * archived thread, 40058/40067 forum tag rules, ...). Timeouts, network errors and 5xx are transient.
 */
export function isPermanent(err: unknown): boolean {
  if (err instanceof PortalError) return err.status === 404;
  if (err instanceof DiscordAPIError) return err.status >= 400 && err.status < 500 && err.status !== 429;
  return false;
}

export class CursorStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Any read error other than a missing file is thrown, not guessed. */
  async read(): Promise<CursorState> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw err;
    }
    const t = text.trim();
    return /^\d+$/.test(t) ? Number(t) : 'unparsable';
  }

  /** Temp file + rename: a crash leaves the old cursor or the new one, never half a number. */
  async write(seq: number): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, `${seq}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

/** The two Discord actions the poller needs; main.ts backs them with the real client. */
export type DiscordSeam = {
  sendToThread(threadId: string, message: BotMessage): Promise<unknown>;
  createForumPost(forumId: string, post: { name: string; message: BotMessage }): Promise<string>;
};

export type EventPollerOptions = {
  api: PortalApi;
  store: CursorStore;
  discord: DiscordSeam;
  config: Config;
  log: Logger;
  intervalMs?: number;
  /** Clock for the retry window; injectable so specs can move it by hours. */
  now?: () => number;
};

export class EventPoller {
  private readonly api: PortalApi;
  private readonly store: CursorStore;
  private readonly discord: DiscordSeam;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly now: () => number;
  // Forum posts made for game reports whose link to the worker failed: the retry links instead of posting again.
  // In memory only, so a restart in that window can still repeat one post.
  private readonly unlinked = new Map<string, string>();
  // Time of the first transient failure per seq, in memory: a restart gives an event a fresh window, which is the safe
  // side (retried again, never lost).
  private readonly firstFailure = new Map<number, number>();
  // Highest seq handled or skipped by this process. The cursor file may lag behind it (a failed write), and an
  // event at or below it is never handled twice; undefined until the first one.
  private handled: number | undefined;
  // Last seq the cursor file is known to hold; behind `handled` after a failed write, which every tick retries.
  private written: number | undefined;
  // A catch-up over the history when there was no cursor file (`top` = the stream's end when it began, `done` = the
  // last seq gone through). In memory only: the cursor file is written once at its end, so a restart midway begins it
  // again, and the game reports it already posted are linked by then and not posted twice.
  private catchUp: { top: number; done: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(opts: EventPollerOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.discord = opts.discord;
    this.config = opts.config;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? 20000;
    this.now = opts.now ?? Date.now;
  }

  /** One pass over the new events; rejects on a transient failure, after recording every event handled before it. */
  async tick(): Promise<void> {
    // A file left behind by a failed write would make a restart repeat what this process already posted (decision 18).
    if (this.handled !== undefined && this.written !== this.handled) await this.advance(this.handled);
    const cursor = await this.startCursor();
    if (cursor === undefined) return;
    const { events } = await this.api.getEvents(cursor);
    const ordered = events.filter((e) => e.seq > cursor).sort((a, b) => a.seq - b.seq);
    for (const event of ordered) {
      await this.handleOrSkip(event);
      await this.advance(event.seq);
    }
  }

  /** Where to read from; undefined when this tick went through the history instead (no usable cursor file). */
  private async startCursor(): Promise<number | undefined> {
    const stored = await this.store.read();
    if (typeof stored === 'number') return Math.max(stored, this.handled ?? 0);
    // The file could not be written earlier in this process: memory knows where the stream is.
    if (this.handled !== undefined) return this.handled;
    if (this.catchUp === undefined && stored === 'unparsable') this.log.error('cursor file unparsable', { state: stored });
    if (this.config.replay) {
      this.log.warn('no cursor: replaying every event from 0 (LUMINA_BOT_REPLAY=1)');
      return 0;
    }
    await this.catchUpHistory();
    return undefined;
  }

  /**
   * No cursor file: a lost or new state dir would otherwise repost every past "Fixed" and "Same bug" in its thread, so
   * those are skipped up to the stream's end as it is now; `created` events are still handled, so a game report that
   * never got its forum post gets it (brief row 6, decision 19). Throws on a transient failure, resumed next tick.
   */
  private async catchUpHistory(): Promise<void> {
    if (this.catchUp === undefined) {
      let top = 0;
      for (;;) {
        const { events } = await this.api.getEvents(top);
        const next = Math.max(top, ...events.map((e) => e.seq));
        if (next === top) break;
        top = next;
      }
      this.catchUp = { top, done: 0 };
      this.log.warn('no cursor: old notifications skipped, game reports still posted', { seq: top });
    }
    const c = this.catchUp;
    while (c.done < c.top) {
      const { events } = await this.api.getEvents(c.done);
      // Events past `top` arrived after the catch-up began: they are new, and the normal ticks handle them in full.
      const ordered = events.filter((e) => e.seq > c.done && e.seq <= c.top).sort((a, b) => a.seq - b.seq);
      if (ordered.length === 0) break;
      for (const event of ordered) {
        if (event.type === 'created') await this.handleOrSkip(event);
        c.done = event.seq;
      }
    }
    this.catchUp = undefined;
    await this.advance(c.top);
  }

  private async advance(seq: number): Promise<void> {
    const top = Math.max(this.handled ?? 0, seq);
    this.handled = top;
    try {
      await this.store.write(top);
      this.written = top;
    } catch (err) {
      this.log.error('cursor not written, kept in memory', { seq, error: errorTag(err) });
    }
  }

  /** Returns when the event is done with (handled or skipped); throws when it should be retried next tick. */
  private async handleOrSkip(event: PortalEvent): Promise<void> {
    const ids = { seq: event.seq, code: event.code, type: event.type };
    if (event.code === null) {
      this.log.info('event of a removed report skipped', ids);
      return;
    }
    try {
      await this.handle({ ...event, code: event.code });
    } catch (err) {
      const failed = { ...ids, error: errorTag(err) };
      if (isPermanent(err)) {
        this.log.warn('event refused for good, skipped', failed);
      } else {
        const now = this.now();
        const since = this.firstFailure.get(event.seq) ?? now;
        const failingMs = now - since;
        if (failingMs < RETRY_WINDOW_MS) {
          this.firstFailure.set(event.seq, since);
          this.log.warn('event not handled, retried next tick', { ...failed, failingMs });
          throw err;
        }
        this.log.error('event skipped after failing for the whole retry window', { ...failed, failingMs });
      }
    }
    this.firstFailure.delete(event.seq);
  }

  /** Polls every intervalMs; the next tick is scheduled only after the previous one ends, so two never overlap. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Resolves when a running tick has ended (it writes its cursor first), at once when none runs. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    // One pending timer at most: a stop()/start() during a slow tick would otherwise leave two chains running.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  private async loop(): Promise<void> {
    this.timer = undefined;
    // A stop() and start() during a slow tick must not start a second one beside it.
    if (this.inFlight) return;
    const run = this.tick().catch((err: unknown) => this.log.warn('event poll failed', { error: errorTag(err) }));
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = undefined;
      this.schedule(this.intervalMs);
    }
  }

  private async handle(event: CodedEvent): Promise<void> {
    switch (event.type) {
      case 'status_changed':
        return this.onStatusChanged(event);
      case 'duplicate_linked':
        return this.onDuplicateLinked(event);
      case 'created':
        return this.onCreated(event);
      default:
        return;
    }
  }

  private async onStatusChanged(event: CodedEvent): Promise<void> {
    // The worker writes `{ from, to, note?, prUrl? }`; `status` is read too for tolerance. An event that names its
    // new status is trusted; only one without it costs a lookup to learn whether it is fixed.
    const { to, status: named } = event.data;
    const status = typeof to === 'string' ? to : named;
    if (typeof status === 'string' && status !== 'fixed') return;
    const report = await this.api.getReport(event.code);
    if (typeof status !== 'string' && report.status !== 'fixed') return;
    const threadId = this.threadOf(report);
    if (!threadId) return;
    const note = typeof event.data['note'] === 'string' ? event.data['note'] : undefined;
    await this.discord.sendToThread(threadId, fixed(event.code, note, report.discord_name));
    this.log.info('fixed posted', { code: event.code, threadId });
  }

  private async onDuplicateLinked(event: CodedEvent): Promise<void> {
    const report = await this.api.getReport(event.code);
    // CONTRACT.md does not name the data key: both spellings are read.
    const named = event.data['duplicateOf'] ?? event.data['duplicate_of'];
    const original = report.duplicate_of ?? (typeof named === 'string' ? named : null);
    if (!original) return;
    const threadId = this.threadOf(report);
    if (!threadId) return;
    await this.discord.sendToThread(threadId, sameBug(event.code, original, await this.originalStatus(original)));
    this.log.info('same bug posted', { code: event.code, threadId });
  }

  /**
   * The report's thread; undefined when it has none for good. A discord report younger than LINK_GRACE_MS without one
   * throws instead (retried): /bug may still be making its post. A row without `created_at` counts as old.
   */
  private threadOf(report: ReportRow): string | undefined {
    if (report.discord_thread_id) return report.discord_thread_id;
    const created = report.created_at;
    if (report.source === 'discord' && typeof created === 'number' && this.now() - created < LINK_GRACE_MS) {
      throw new ThreadNotLinkedYet('thread not linked yet');
    }
    return undefined;
  }

  /** The original's public status; a vanished original reads as unknown, a worker failure is retried. */
  private async originalStatus(code: string): Promise<PublicStatus | undefined> {
    try {
      const row = await this.api.getReport(code);
      // A chain of duplicates is not followed: one lookup is the "cheap" the design allows.
      return row.status === 'duplicate' ? 'looking' : toPublicStatus(row.status);
    } catch (err) {
      if (err instanceof PortalError && err.status === 404) return undefined;
      throw err;
    }
  }

  private async onCreated(event: CodedEvent): Promise<void> {
    const pending = this.unlinked.get(event.code);
    if (pending !== undefined) {
      await this.api.linkThread(event.code, pending);
      this.unlinked.delete(event.code);
      return;
    }
    const report = await this.api.getReport(event.code);
    if (report.source !== 'game' || report.discord_thread_id) return;
    const threadId = await this.discord.createForumPost(this.config.forumChannelId, gameReportPost(report));
    this.unlinked.set(event.code, threadId);
    await this.api.linkThread(event.code, threadId);
    this.unlinked.delete(event.code);
    this.log.info('game report posted', { code: event.code, threadId });
  }
}
