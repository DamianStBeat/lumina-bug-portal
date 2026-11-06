// The "See status" button: answers only the player who pressed it, with the public status (CONTRACT.md Statuses).
// Never throws.
import { type ButtonInteraction, MessageFlags } from 'discord.js';
import type { BotDeps } from './bugCommand.ts';
import { errorTag, type PortalApi, type PublicStatus, toPublicStatus } from './portal.ts';
import { statusReply, tryAgain } from './text.ts';

// The code goes into a worker URL: anything but the exact shape is someone else's custom id or a forged one.
const STATUS_ID = /^status:(LUM-\d{6})$/;

/** A duplicate shows the original's public status; one lookup only, and "looking" when it cannot be had. */
async function publicStatusOf(api: PortalApi, code: string): Promise<PublicStatus> {
  const row = await api.getReport(code);
  if (row.status !== 'duplicate') return toPublicStatus(row.status) ?? 'received';
  if (typeof row.duplicate_of !== 'string') return 'looking';
  try {
    const original = await api.getReport(row.duplicate_of);
    return original.status === 'duplicate' ? 'looking' : (toPublicStatus(original.status) ?? 'looking');
  } catch {
    return 'looking';
  }
}

export async function handleButton(i: ButtonInteraction, deps: BotDeps): Promise<void> {
  const code = STATUS_ID.exec(i.customId)?.[1];
  if (code === undefined) return;
  try {
    // The worker may take longer than Discord's 3 s window.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    deps.log.warn('status button not acknowledged', { code, error: errorTag(err) });
    return;
  }
  let reply;
  try {
    reply = statusReply(code, await publicStatusOf(deps.api, code));
  } catch (err) {
    deps.log.warn('status lookup failed', { code, error: errorTag(err) });
    reply = tryAgain();
  }
  // editReply keeps the visibility chosen at deferReply; its typings refuse `flags`.
  const { flags: _visibility, ...options } = reply;
  await i.editReply(options).catch((e: unknown) => deps.log.warn('status answer not sent', { code, error: errorTag(e) }));
}
