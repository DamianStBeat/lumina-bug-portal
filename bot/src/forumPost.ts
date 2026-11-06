// A new post in the bug forum becomes a report (brief rows 2, 4, 7, 8). Posts by bots (this one included) and by
// webhooks (the game's old one) are not players' and are left alone. Never throws.
import type { AnyThreadChannel, Message } from 'discord.js';
import { type FileDeps, playerName } from './bugCommand.ts';
import { copyAttachments } from './files.ts';
import { errorTag } from './portal.ts';
import { tryAgain, weHaveIt } from './text.ts';

const WHAT_MAX = 2000; // CONTRACT.md: what <= 2000; a Nitro message can carry 4000
const STARTER_RETRY_MS = 1500;

/** Cut by UTF-16 length, as the worker counts, without splitting an emoji in two. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * A forum post's starter message can arrive a moment after the thread (Discord answers Unknown Message meanwhile),
 * so one late retry; after that the post is treated as unreadable, not as empty.
 */
async function starterOf(thread: AnyThreadChannel): Promise<Message | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const m = await thread.fetchStarterMessage();
      if (m) return m;
    } catch {
      // retried once below
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, STARTER_RETRY_MS));
  }
  return null;
}

export async function handleThreadCreate(thread: AnyThreadChannel, newlyCreated: boolean, deps: FileDeps): Promise<void> {
  const { api, config, log } = deps;
  if (!newlyCreated || thread.parentId !== config.forumChannelId) return;
  try {
    const starter = await starterOf(thread);
    if (!starter) {
      log.warn('forum post without a readable first message', { threadId: thread.id });
      return;
    }
    if (starter.author.bot || starter.webhookId) return;

    const title = cut(thread.name, 200);
    let created: { code: string; reportToken: string };
    try {
      created = await api.createDiscordReport({
        discordUserId: starter.author.id,
        discordName: playerName(starter.author, starter.member),
        threadId: thread.id,
        title,
        what: cut(starter.content.trim() ? starter.content : title, WHAT_MAX),
      });
    } catch (err) {
      log.warn('forum report not created', { threadId: thread.id, error: errorTag(err) });
      // A thread message is public: the ephemeral flag of the interaction answer does not apply here.
      const { flags: _ephemeral, ...plain } = tryAgain();
      await thread.send(plain).catch((e: unknown) => log.warn('try-again not sent', { threadId: thread.id, error: errorTag(e) }));
      return;
    }
    const { code, reportToken } = created;
    log.info('forum report created', { code, threadId: thread.id });

    // The reply comes before the copy: a large video can take minutes and the player is waiting for the code.
    await thread.send(weHaveIt(code, config.siteBase)).catch((e: unknown) => {
      log.warn('forum reply not sent', { code, threadId: thread.id, error: errorTag(e) });
    });
    if (starter.attachments.size > 0) {
      const res = await copyAttachments(api, code, reportToken, starter.attachments.values(), deps.fetchImpl);
      log.info('forum file copy', { code, ...res });
    }
  } catch (err) {
    log.error('forum post handler failed', { threadId: thread.id, error: errorTag(err) });
  }
}
