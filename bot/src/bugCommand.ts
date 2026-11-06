// The /bug slash command (brief rows 1, 3, 7): a modal, then a report, a forum post with the bot's reply in it,
// and an answer only the player sees. Handlers never throw: a failure is logged and the player still gets an answer.
import {
  type Attachment,
  ChannelType,
  type ChatInputCommandInteraction,
  FileUploadBuilder,
  type GuildMember,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type User,
} from 'discord.js';
import type { Config, Logger } from './config.ts';
import { copyAttachments, sanitiseFilename } from './files.ts';
import { errorTag, type FetchLike, type PortalApi, type WhereArea } from './portal.ts';
import { type BotReply, bugForumPost, cut, sentReply, tryAgain, weHaveIt } from './text.ts';

export type BotDeps = { api: PortalApi; config: Config; log: Logger };
export type FileDeps = BotDeps & { fetchImpl: FetchLike };

export const BUG_MODAL_ID = 'bug-modal';

const WHAT_MAX = 2000; // CONTRACT.md: what <= 2000
// Discord's re-upload holds about twice the file in memory and the service has MemoryMax=300M: above this the
// post carries the text only, the archive copy (streamed) keeps the file.
const REPOST_MAX_BYTES = 25 * 1024 * 1024;
// One re-post at a time for the same reason; module state, so it covers every interaction of this process.
let repostInFlight = false;

// The approved modal has a free text field (its placeholder lists the areas); the worker takes only CONTRACT's
// where_area values, so the typed text is mapped on the whole field. A Map, not an object: a player typing
// "constructor" must not find a prototype property.
const WHERE_AREAS = new Map<string, WhereArea>([
  ['match', 'match'],
  ['lobby', 'lobby'],
  ['shop', 'shop'],
  ['clan', 'clan'],
  ['crate', 'crates'],
  ['crates', 'crates'],
  ['something else', 'other'],
  ['other', 'other'],
]);

/**
 * The report's `what` and `where` from the two fields. A place that is not an area becomes `other`, and the typed
 * words are kept at the end of `what` so the team still reads them; only that suffix is cut to fit, never the
 * player's own text. Empty means "not said": no `where` at all.
 */
export function placeReport(what: string, typedWhere: string): { what: string; where?: WhereArea } {
  const typed = typedWhere.trim();
  if (!typed) return { what };
  const area = WHERE_AREAS.get(typed.toLowerCase().replace(/\.$/, ''));
  if (area) return { what, where: area };
  return { what: what + cut(`\n\nWhere: ${typed}`, WHAT_MAX - what.length), where: 'other' };
}

export function bugCommandData(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder().setName('bug').setDescription('Report a bug in Lumina').toJSON();
}

export function buildBugModal(): ModalBuilder {
  const what = new TextInputBuilder()
    .setCustomId('what')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000)
    .setPlaceholder('The boss stopped on the bridge and the wave never ended.');
  const where = new TextInputBuilder()
    .setCustomId('where')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder('Match, Lobby, Shop, Crates, Clan, Something else');
  // No MB number in the label (Damian, hub Q-394): Discord shows the player's own limit.
  const file = new FileUploadBuilder().setCustomId('file').setMinValues(0).setMaxValues(1).setRequired(false);
  return new ModalBuilder()
    .setCustomId(BUG_MODAL_ID)
    .setTitle('🐞 Report a bug')
    .addLabelComponents(
      new LabelBuilder().setLabel('What happened?').setTextInputComponent(what),
      new LabelBuilder().setLabel('Where in the game?').setTextInputComponent(where),
      new LabelBuilder().setLabel('Video or picture').setFileUploadComponent(file),
    );
}

/** The modal must be the first answer to the command, so nothing is deferred here. */
export async function handleBugCommand(i: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  try {
    await i.showModal(buildBugModal());
  } catch (err) {
    deps.log.warn('bug modal not shown', { interaction: i.id, error: errorTag(err) });
  }
}

/** The server name when Discord sent the member, else the account's display name. */
export function playerName(user: Pick<User, 'username' | 'globalName'>, member: unknown): string {
  const display = (member as Partial<GuildMember> | null)?.displayName;
  return (typeof display === 'string' && display) || user.globalName || user.username;
}

function readField<T>(read: () => T, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

/** discord.js typings refuse `flags` on editReply: the visibility was already chosen at deferReply. */
function edit(reply: BotReply): Omit<BotReply, 'flags'> {
  const { flags: _visibility, ...rest } = reply;
  return rest;
}

export async function handleBugModalSubmit(i: ModalSubmitInteraction, deps: FileDeps): Promise<void> {
  const { api, config, log } = deps;
  try {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    // Past Discord's 3 s window nothing can reach the player; the report is not made without a way to tell them.
    log.warn('bug modal not acknowledged', { interaction: i.id, error: errorTag(err) });
    return;
  }

  // Optional fields Discord leaves out read as empty; a missing `what` fails the create below like a worker refusal.
  const what = readField(() => i.fields.getTextInputValue('what'), '');
  const where = readField(() => i.fields.getTextInputValue('where'), '');
  const file: Attachment | undefined = readField(() => i.fields.getUploadedFiles('file', false)?.first(), undefined);

  let created: { code: string; reportToken: string };
  try {
    if (!what.trim()) throw new Error('empty report');
    created = await api.createDiscordReport({
      discordUserId: i.user.id,
      discordName: playerName(i.user, i.member),
      ...placeReport(what, where),
    });
  } catch (err) {
    log.warn('bug report not created', { user: i.user.id, error: errorTag(err) });
    await i.editReply(edit(tryAgain())).catch((e: unknown) => log.warn('try-again not sent', { error: errorTag(e) }));
    return;
  }
  const { code, reportToken } = created;
  log.info('bug report created', { code, user: i.user.id });

  // From here the report exists: whatever fails, the player still gets the code.
  try {
    const threadId = await postToForum(i, what, file, code, deps);
    await api.linkThread(code, threadId);
  } catch (err) {
    log.warn('bug forum post or link failed', { code, error: errorTag(err) });
  }

  await i.editReply(edit(sentReply(code, config.siteBase))).catch((e: unknown) => {
    log.warn('bug answer not sent', { code, error: errorTag(e) });
  });

  // After the answer: a large video can take minutes, and the player should not wait on it.
  if (file) {
    const res = await copyAttachments(api, code, reportToken, [file], deps.fetchImpl, log).catch(() => undefined);
    log.info('bug file copy', { code, ...res });
  }
}

/** Creates the forum post and the bot's reply in it; returns the thread id. */
async function postToForum(
  i: ModalSubmitInteraction,
  what: string,
  file: Attachment | undefined,
  code: string,
  deps: FileDeps,
): Promise<string> {
  const forum = await i.client.channels.fetch(deps.config.forumChannelId);
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('forum channel unavailable');
  // A file over this server's upload limit or the memory ceiling stays in the archive only; the post carries the text.
  const fits = file !== undefined && file.size <= Math.min(i.attachmentSizeLimit, REPOST_MAX_BYTES);
  const repost = fits && !repostInFlight;
  if (fits && !repost) deps.log.info('bug file not re-posted, another re-post in flight', { code });
  const files = repost ? [{ attachment: file.url, name: sanitiseFilename(file.name) }] : [];
  if (repost) repostInFlight = true;
  let thread;
  try {
    thread = await forum.threads.create(bugForumPost(what, files));
  } catch (err) {
    if (files.length === 0) throw err;
    deps.log.warn('bug post with file refused, posting text only', { code, error: errorTag(err) });
    thread = await forum.threads.create(bugForumPost(what));
  } finally {
    if (repost) repostInFlight = false;
  }
  try {
    await thread.send(weHaveIt(code, deps.config.siteBase));
  } catch (err) {
    deps.log.warn('bug thread reply failed', { code, threadId: thread.id, error: errorTag(err) });
  }
  return thread.id;
}
