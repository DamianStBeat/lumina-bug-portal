// Follows the worker's event log and tells Discord what changed (brief rows 5 and 6). The cursor is written after
// every handled event, so a restart never posts one twice; a failure stops the batch and the next tick retries it.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config, Logger } from './config.ts';
import { errorTag, type PortalApi, PortalError, type PortalEvent, type PublicStatus, toPublicStatus } from './portal.ts';
import { type BotMessage, fixed, gameReportPost, sameBug } from './text.ts';

export class CursorStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 0 when the file is missing or unparsable ("never polled"); any other read error is thrown, not guessed. */
  async read(): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    const t = text.trim();
    return /^\d+$/.test(t) ? Number(t) : 0;
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
};

export class EventPoller {
  private readonly api: PortalApi;
  private readonly store: CursorStore;
  private readonly discord: DiscordSeam;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly intervalMs: number;
  // Forum posts made for game reports whose link to the worker failed: the retry links instead of posting again.
  // In memory only, so a restart in that window can still repeat one post.
  private readonly unlinked = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private ticking = false;

  constructor(opts: EventPollerOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.discord = opts.discord;
    this.config = opts.config;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? 20000;
  }

  /** One pass over the new events; rejects on the first failure, after recording every event handled before it. */
  async tick(): Promise<void> {
    const cursor = await this.store.read();
    const { events } = await this.api.getEvents(cursor);
    const ordered = events.filter((e) => e.seq > cursor).sort((a, b) => a.seq - b.seq);
    for (const event of ordered) {
      try {
        await this.handle(event);
      } catch (err) {
        this.log.warn('event not handled, retried next tick', { seq: event.seq, code: event.code, error: errorTag(err) });
        throw err;
      }
      await this.store.write(event.seq);
    }
  }

  /** Polls every intervalMs; the next tick is scheduled only after the previous one ends, so two never overlap. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      this.log.warn('event poll failed', { error: errorTag(err) });
    } finally {
      this.ticking = false;
      this.schedule(this.intervalMs);
    }
  }

  private async handle(event: PortalEvent): Promise<void> {
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

  private async onStatusChanged(event: PortalEvent): Promise<void> {
    const status = event.data['status'];
    // An event that names its status is trusted; only one without it costs a lookup to learn whether it is fixed.
    if (typeof status === 'string' && status !== 'fixed') return;
    const report = await this.api.getReport(event.code);
    if (typeof status !== 'string' && report.status !== 'fixed') return;
    const threadId = report.discord_thread_id;
    if (!threadId) return;
    const note = typeof event.data['note'] === 'string' ? event.data['note'] : undefined;
    await this.discord.sendToThread(threadId, fixed(event.code, note, report.discord_name));
    this.log.info('fixed posted', { code: event.code, threadId });
  }

  private async onDuplicateLinked(event: PortalEvent): Promise<void> {
    const report = await this.api.getReport(event.code);
    const threadId = report.discord_thread_id;
    const original = report.duplicate_of ?? (typeof event.data['duplicateOf'] === 'string' ? event.data['duplicateOf'] : null);
    if (!threadId || !original) return;
    await this.discord.sendToThread(threadId, sameBug(event.code, original, await this.originalStatus(original)));
    this.log.info('same bug posted', { code: event.code, threadId });
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

  private async onCreated(event: PortalEvent): Promise<void> {
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
