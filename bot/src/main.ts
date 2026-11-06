// The running bot: one gateway connection (outbound only), the handlers, and the event poller. Logs go to stdout
// (journald under systemd); they carry codes, ids and error names only.
import path from 'node:path';
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type Interaction,
  RESTJSONErrorCodes,
} from 'discord.js';
import { type BotDeps, BUG_MODAL_ID, handleBugCommand, handleBugModalSubmit } from './bugCommand.ts';
import { handleButton } from './buttons.ts';
import { type Config, ConfigError, type Logger, loadConfig } from './config.ts';
import { CursorStore, type DiscordSeam, EventPoller } from './events.ts';
import { handleThreadCreate } from './forumPost.ts';
import { errorTag, PortalApi } from './portal.ts';

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
const fileDeps = { ...deps, fetchImpl: (input: string, init?: RequestInit) => fetch(input, init) };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // Second guard behind the per-message allowedMentions in text.ts: nothing this client sends can ping.
  allowedMentions: { parse: [] },
});

/** A thread deleted since the report was made would block the event stream forever: it is skipped, not retried. */
function isGone(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownChannel;
}

const discord: DiscordSeam = {
  async sendToThread(threadId, message) {
    let channel;
    try {
      channel = await client.channels.fetch(threadId);
    } catch (err) {
      if (!isGone(err)) throw err;
      log.warn('thread gone, event skipped', { threadId });
      return undefined;
    }
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

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  poller.stop();
  await client.destroy().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

client.login(config.discordToken).catch((err: unknown) => {
  // The login error never carries the token itself; its name is enough to tell a bad token from a network fault.
  log.error('login failed', { error: errorTag(err) });
  process.exit(1);
});
