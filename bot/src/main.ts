// The running bot: one gateway connection (outbound only), the handlers, and the event poller. Logs go to stdout
// (journald under systemd); they carry codes, ids and error names only.
import path from 'node:path';
import { ChannelType, Client, Events, GatewayIntentBits, type Interaction } from 'discord.js';
import { type BotDeps, BUG_MODAL_ID, handleBugCommand, handleBugModalSubmit } from './bugCommand.ts';
import { handleButton } from './buttons.ts';
import { type Config, ConfigError, type Logger, loadConfig } from './config.ts';
import { CursorStore, type DiscordSeam, EventPoller } from './events.ts';
import { handleThreadCreate } from './forumPost.ts';
import { copyLimiter } from './limiter.ts';
import { errorTag, PortalApi } from './portal.ts';
import { stopThenDestroy } from './shutdown.ts';

function line(level: string, msg: string, data?: unknown): void {
  let extra = '';
  if (data !== undefined) {
    try {
      extra = ` ${JSON.stringify(data)}`;
    } catch {
      extra = ' [unserialisable]';
    }
  }
  console.log(`${level} ${msg}${extra}`);
}

const log: Logger = {
  info: (msg, data) => line('info', msg, data),
  warn: (msg, data) => line('warn', msg, data),
  error: (msg, data) => line('error', msg, data),
};

// A rejection nobody awaited is a bug to see in the logs, not a reason to drop the gateway connection.
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { error: errorTag(reason) }));

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // ConfigError names the missing variable, never a value.
  log.error(err instanceof ConfigError ? err.message : 'config not loaded', { error: errorTag(err) });
  process.exit(1);
}

const api = new PortalApi({ base: config.apiBase, agentKey: config.agentKey });
const deps: BotDeps = { api, config, log };
const fileDeps = { ...deps, fetchImpl: (input: string, init?: RequestInit) => fetch(input, init), copies: copyLimiter };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // Second guard behind the per-message allowedMentions in text.ts: nothing this client sends can ping.
  allowedMentions: { parse: [] },
});

// A deleted, locked or forbidden thread throws a Discord 4xx here; the poller skips such an event (events.ts
// isPermanent) instead of letting it block the stream.
const discord: DiscordSeam = {
  async sendToThread(threadId, message) {
    const channel = await client.channels.fetch(threadId);
    if (!channel?.isThread()) {
      log.warn('not a thread, event skipped', { threadId });
      return undefined;
    }
    return channel.send(message);
  },
  async createForumPost(forumId, post) {
    const forum = await client.channels.fetch(forumId);
    if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('forum channel unavailable');
    const thread = await forum.threads.create(post);
    return thread.id;
  },
};

const poller = new EventPoller({
  api,
  store: new CursorStore(path.join(config.stateDir, 'cursor')),
  discord,
  config,
  log,
});

function onInteraction(i: Interaction): Promise<void> | undefined {
  // The command is registered in one guild; anything from elsewhere is not ours to answer.
  if (i.guildId !== config.guildId) return undefined;
  if (i.isChatInputCommand() && i.commandName === 'bug') return handleBugCommand(i, deps);
  if (i.isModalSubmit() && i.customId === BUG_MODAL_ID) return handleBugModalSubmit(i, fileDeps);
  if (i.isButton() && i.customId.startsWith('status:')) return handleButton(i, deps);
  return undefined;
}

client.on(Events.InteractionCreate, (i) => {
  onInteraction(i)?.catch((err: unknown) => log.error('interaction handler failed', { error: errorTag(err) }));
});
client.on(Events.ThreadCreate, (thread, newlyCreated) => {
  handleThreadCreate(thread, newlyCreated, fileDeps).catch((err: unknown) =>
    log.error('thread handler failed', { error: errorTag(err) }),
  );
});
client.on(Events.Error, (err) => log.error('client error', { error: errorTag(err) }));
client.once(Events.ClientReady, (c) => {
  log.info('connected', { user: c.user.id, guild: config.guildId, forum: config.forumChannelId });
  poller.start();
});

const COPY_DRAIN_MS = 20000;
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  // A running tick is let finish (it writes its cursor), at most 5 s. Then running archive copies get 20 s, after
  // which they are aborted and their half-made attachments deleted (decision 22); copies still queued never start.
  // Every step is capped, so the whole stop stays under systemd's 90 s.
  await stopThenDestroy(
    () => poller.stop(),
    async () => {
      try {
        await copyLimiter.drain(COPY_DRAIN_MS);
      } finally {
        await client.destroy();
      }
    },
    5000,
  );
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

client.login(config.discordToken).catch((err: unknown) => {
  // The login error never carries the token itself; its name is enough to tell a bad token from a network fault.
  log.error('login failed', { error: errorTag(err) });
  process.exit(1);
});
