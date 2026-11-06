// Settings come from bot.env (systemd EnvironmentFile). Errors name the missing variable and never echo a value,
// so a token cannot reach journald through a startup failure.
import path from 'node:path';

export type Config = {
  discordToken: string;
  appId: string;
  guildId: string;
  forumChannelId: string;
  /** Full worker API base including `/api/v1`, no trailing slash. */
  apiBase: string;
  agentKey: string;
  /** Public site base (for `/add?code=`), no trailing slash. */
  siteBase: string;
  /** Holds the event cursor; created with mode 700 on first write. */
  stateDir: string;
  /**
   * LUMINA_BOT_REPLAY=1: with no usable cursor file the poller handles every event from 0 instead of skipping the
   * history. Absent means off: a lost state dir must not repost every past "Fixed" by default.
   */
  replay?: boolean;
};

/** Every module logs through this; callers pass codes, ids and error names only, never tokens or player text. */
export type Logger = {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const DEFAULT_GUILD_ID = '1440485385112125563';
const DEFAULT_FORUM_CHANNEL_ID = '1561007238103961620';

type Env = Record<string, string | undefined>;

// An empty value is a variable left blank in bot.env ("not set yet"), not a setting.
function optional(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function required(env: Env, name: string): string {
  const v = optional(env, name);
  if (v === undefined) throw new ConfigError(`missing required setting ${name}`);
  return v;
}

function noTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: Env): Config {
  let stateDir = optional(env, 'LUMINA_BOT_STATE_DIR');
  if (stateDir === undefined) {
    const home = required(env, 'HOME');
    stateDir = path.join(home, '.local', 'state', 'lumina-bug-bot');
  }
  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    appId: required(env, 'DISCORD_APP_ID'),
    guildId: optional(env, 'DISCORD_GUILD_ID') ?? DEFAULT_GUILD_ID,
    forumChannelId: optional(env, 'BUG_FORUM_CHANNEL_ID') ?? DEFAULT_FORUM_CHANNEL_ID,
    apiBase: noTrailingSlash(required(env, 'PORTAL_API_BASE')),
    agentKey: required(env, 'AGENT_KEY'),
    siteBase: noTrailingSlash(required(env, 'SITE_BASE')),
    stateDir,
    // Only "1" turns it on: a blank line in bot.env is "not set yet", and "0" or "false" must not mean yes.
    replay: optional(env, 'LUMINA_BOT_REPLAY') === '1',
  };
}
