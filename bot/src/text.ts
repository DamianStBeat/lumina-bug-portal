// Every message the bot sends, as plain option objects (texts from plan/preview/shots/discord-thread.png, voice of
// CONTRACT.md "Player-facing text"). Player text is escaped in content and embeds (thread names: see threadName) and
// cut to the field it lands in, never put in an embed title, and every message refuses to ping anyone.
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  MessageFlags,
  type MessageMentionOptions,
} from 'discord.js';
import type { PublicStatus, ReportRow } from './portal.ts';

/** A message posted in a channel or thread. */
export type BotMessage = BaseMessageOptions & { allowedMentions: MessageMentionOptions };
/** An answer only the player sees. */
export type BotReply = BotMessage & { flags: MessageFlags.Ephemeral };
export type ForumPost = { name: string; message: BotMessage };

// Discord limits for the fields we fill.
const CONTENT_MAX = 2000;
const THREAD_NAME_MAX = 100;
const NOTE_MAX = 3000; // of the 4096 an embed description allows; the fixed sentence and thanks need the rest
const NAME_MAX = 100;

const COLOR_AMBER = 0xf0b232;
const COLOR_GREEN = 0x5be08e;
const COLOR_GREY = 0x949ba4;

const noMentions = (): MessageMentionOptions => ({ parse: [] });

// Off by default in discord.js: a masked link would let a player post a disguised URL, a heading or list would
// restyle the post. "Shown literally" means all of it.
const ESCAPE_ALL = { heading: true, bulletedList: true, numberedList: true, maskedLink: true };

/** Escapes, then cuts to `max` with an ellipsis; a cut never leaves a lone backslash escaping what follows. */
export function escapeCut(text: string, max: number): string {
  const escaped = escapeMarkdown(text, ESCAPE_ALL);
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max - 1);
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function linkButton(code: string, siteBase: string): ButtonBuilder {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Add a bigger video')
    .setURL(`${siteBase}/add?code=${encodeURIComponent(code)}`);
}

function weHaveItEmbed(code: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`We have it · ${code}`)
    .setDescription(
      "The team and our checker look at it next. We'll write here when it changes.\n\n" +
        'Video bigger than Discord allows? Add it on our site with the same code.',
    )
    .setColor(COLOR_AMBER);
}

export function weHaveIt(code: string, siteBase: string): BotMessage {
  const status = new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('See status').setCustomId(`status:${code}`);
  return {
    embeds: [weHaveItEmbed(code)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton(code, siteBase), status)],
    allowedMentions: noMentions(),
  };
}

/** The ephemeral answer after `/bug`: the player already sees the thread, so only the link button. */
export function sentReply(code: string, siteBase: string): BotReply {
  return {
    embeds: [weHaveItEmbed(code)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton(code, siteBase))],
    allowedMentions: noMentions(),
    flags: MessageFlags.Ephemeral,
  };
}

export function fixed(code: string, note?: string, playerName?: string | null): BotMessage {
  const parts: string[] = [];
  if (note?.trim()) parts.push(escapeCut(note.trim(), NOTE_MAX));
  parts.push("It is in the game from today's update.");
  if (playerName?.trim()) parts.push(`Thanks, ${escapeCut(playerName.trim(), NAME_MAX)}.`);
  return {
    embeds: [new EmbedBuilder().setTitle(`Fixed · ${code}`).setDescription(parts.join(' ')).setColor(COLOR_GREEN)],
    allowedMentions: noMentions(),
  };
}

/** "which is fixed" only when the original really is; an unknown status is not a claim. */
export function sameBug(code: string, originalCode: string, originalPublicStatus?: PublicStatus): BotMessage {
  const which = originalPublicStatus === 'fixed' ? ', which is fixed' : '';
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Same bug · ${code}`)
        .setDescription(`This is the same as ${escapeCut(originalCode, 40)}${which}. Thanks for telling us.`)
        .setColor(COLOR_GREY),
    ],
    allowedMentions: noMentions(),
  };
}

const STATUS_TEXT: Record<PublicStatus, string> = {
  received: 'Received.',
  looking: "We're looking.",
  fixed: 'Fixed. It is in the game.',
  checked: 'Checked.',
};

export function statusReply(code: string, publicStatus: PublicStatus): BotReply {
  return { content: `${code}: ${STATUS_TEXT[publicStatus]}`, allowedMentions: noMentions(), flags: MessageFlags.Ephemeral };
}

export function tryAgain(): BotReply {
  return { content: "Couldn't send it. Try again in a minute.", allowedMentions: noMentions(), flags: MessageFlags.Ephemeral };
}

/** Cut by UTF-16 length, as the worker and Discord count, without splitting an emoji in two. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

// C0 and C1 control characters: a name is one line of plain text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Not escaped: Discord renders no markdown in a post title, so a backslash would show, and a mention in a name never
 * notifies. Only the first line, without control characters.
 */
function threadName(prefix: string, text: string | null | undefined, fallback: string): string {
  const firstLine = (text ?? '').split('\n')[0]!.replace(CONTROL, '').trim();
  if (!firstLine) return fallback;
  return prefix + cut(firstLine, THREAD_NAME_MAX - prefix.length);
}

/** The forum post `/bug` makes: first line as the name, the whole text as the starter, the file when it fits. */
export function bugForumPost(what: string, files?: BaseMessageOptions['files']): ForumPost {
  const message: BotMessage = { content: escapeCut(what, CONTENT_MAX), allowedMentions: noMentions() };
  if (files && files.length > 0) message.files = files;
  return { name: threadName('', what, 'Bug report'), message };
}

const FENCE_OPEN = '```json\n';
const FENCE_CLOSE = '\n```';

/** Pretty JSON of the game context, or undefined when there is none ("missing" is not an empty context). */
function contextJson(raw: unknown): string | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // shown as text; the worker validated it, so this is a defect worth seeing, not hiding
    }
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && Object.keys(value).length === 0) return undefined;
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  // Inside a code block nothing can be escaped, so a backtick is swapped for a look-alike that cannot close it.
  return json.replaceAll('`', 'ˋ');
}

/** A report from the game gets its own forum post so the forum stays the shared feed. */
export function gameReportPost(report: ReportRow): ForumPost {
  const name = threadName('Bug report: ', report.title, 'Bug report');
  const what = typeof report.what === 'string' ? report.what : '';
  const json = contextJson(report.game_context);
  if (json === undefined) {
    return { name, message: { content: escapeCut(what, CONTENT_MAX), allowedMentions: noMentions() } };
  }
  const overhead = 1 + FENCE_OPEN.length + FENCE_CLOSE.length;
  // The player's words come first; a long context gives way, but the text keeps at least half the message.
  const textBudget = Math.max(CONTENT_MAX - overhead - json.length, CONTENT_MAX / 2);
  const text = escapeCut(what, textBudget);
  const jsonBudget = CONTENT_MAX - overhead - text.length;
  const block = json.length <= jsonBudget ? json : `${json.slice(0, jsonBudget - 1)}…`;
  return { name, message: { content: `${text}\n${FENCE_OPEN}${block}${FENCE_CLOSE}`, allowedMentions: noMentions() } };
}
