// Shared helpers for the specs: a Config pointing at the fake worker, a recording logger, temp dirs.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import { AGENT_KEY } from './worker.ts';

export const FORUM_ID = '1561007238103961620';
export const GUILD_ID = '1440485385112125563';
export const SITE_BASE = 'https://bugs.example.test';
export const DISCORD_TOKEN = 'test-discord-token-not-real';
export const BOT_USER_ID = '900000000000000001';
export const TRY_AGAIN = "Couldn't send it. Try again in a minute.";

export function makeConfig(apiBase: string, stateDir: string): Config {
  return {
    discordToken: DISCORD_TOKEN,
    appId: '900000000000000001',
    guildId: GUILD_ID,
    forumChannelId: FORUM_ID,
    apiBase,
    agentKey: AGENT_KEY,
    siteBase: SITE_BASE,
    stateDir,
  };
}

export type LogLine = { level: 'info' | 'warn' | 'error'; msg: string; data: unknown };

export function makeLogger(): {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  lines: LogLine[];
  text(): string;
} {
  const lines: LogLine[] = [];
  const add = (level: LogLine['level']) => (msg: string, data?: unknown) => {
    lines.push({ level, msg, data });
  };
  return {
    info: add('info'),
    warn: add('warn'),
    error: add('error'),
    lines,
    text() {
      return lines
        .map((l) => {
          let d = '';
          try {
            d = JSON.stringify(l.data, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)) ?? '';
          } catch {
            d = String(l.data);
          }
          return `${l.level} ${l.msg} ${d}`;
        })
        .join('\n');
    },
  };
}

export async function makeTempDir(prefix = 'lumina-bot-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}

/** Lets pending timers and sockets run (real time: the bot uses real timers and real HTTP). */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
