// Fake Discord objects: plain objects with only the methods the handlers call. They record what was sent where,
// with which options, and they keep Discord's own rules where a looser fake would hide a bug (an interaction is
// acknowledged once; editReply/followUp need an acknowledgement first; showModal only before one).
// Modal fields and attachments are the real discord.js classes (ModalSubmitFields, Attachment) built from raw API
// data, so `fields.getTextInputValue` / `getUploadedFiles` behave exactly as in production.
import {
  Attachment,
  ChannelType,
  Collection,
  MessageFlags,
  MessageFlagsBitField,
  ModalSubmitFields,
  ModalSubmitInteraction,
} from 'discord.js';
import { BOT_USER_ID, FORUM_ID, GUILD_ID } from './common.ts';

export type RawAttachment = { id: string; name: string; size: number; contentType?: string; url?: string };

export function cdnUrl(a: { id: string; name: string }): string {
  return `https://cdn.discordapp.com/attachments/${FORUM_ID}/${a.id}/${encodeURIComponent(a.name)}`;
}

function rawApiAttachment(a: RawAttachment): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: a.id,
    filename: a.name,
    size: a.size,
    url: a.url ?? cdnUrl(a),
    proxy_url: (a.url ?? cdnUrl(a)).replace('cdn.discordapp.com', 'media.discordapp.net'),
  };
  if (a.contentType !== undefined) raw['content_type'] = a.contentType;
  return raw;
}

/** A real discord.js Attachment. Its constructor is private in the typings, public in JS: hence the cast. */
export function makeAttachment(a: RawAttachment): Attachment {
  const Ctor = Attachment as unknown as new (data: Record<string, unknown>) => Attachment;
  return new Ctor(rawApiAttachment(a));
}

export function attachmentCollection(list: RawAttachment[]): Collection<string, Attachment> {
  return new Collection(list.map((a) => [a.id, makeAttachment(a)] as [string, Attachment]));
}

/** Real ModalSubmitFields for the `/bug` modal (labels `what`, `where`, `file`), as Discord sends them. */
export function bugModalFields(what: string, where: string, file?: RawAttachment): ModalSubmitFields {
  const raw = [
    { type: 18, id: 1, component: { type: 4, id: 2, custom_id: 'what', value: what } },
    { type: 18, id: 3, component: { type: 4, id: 4, custom_id: 'where', value: where } },
    { type: 18, id: 5, component: { type: 19, id: 6, custom_id: 'file', values: file ? [file.id] : [] } },
  ];
  const resolved = file ? { attachments: { [file.id]: rawApiAttachment(file) } } : undefined;
  const components = raw.map((c) =>
    // transformComponent is the static discord.js uses on a real interaction; typed loosely in the d.ts.
    (ModalSubmitInteraction as unknown as { transformComponent(c: unknown, r: unknown, x: unknown): unknown })
      .transformComponent(c, resolved, {}),
  );
  const Ctor = ModalSubmitFields as unknown as new (c: unknown[], r?: unknown) => ModalSubmitFields;
  return new Ctor(components, undefined);
}

// ---------------------------------------------------------------- messages, threads, forum

export type FakeUser = { id: string; bot: boolean; username: string; globalName: string | null; system: boolean };

export function makeUser(id: string, username: string, bot = false): FakeUser {
  return { id, bot, username, globalName: null, system: false };
}

export type FakeMessage = {
  id: string;
  channelId: string;
  content: string;
  author: FakeUser;
  webhookId: string | null;
  attachments: Collection<string, Attachment>;
  member: { displayName: string } | null;
};

export function makeMessage(opts: {
  id?: string;
  channelId: string;
  content: string;
  author: FakeUser;
  webhookId?: string | null;
  attachments?: RawAttachment[];
}): FakeMessage {
  return {
    id: opts.id ?? opts.channelId, // a forum post's starter message has the thread's id
    channelId: opts.channelId,
    content: opts.content,
    author: opts.author,
    webhookId: opts.webhookId ?? null,
    attachments: attachmentCollection(opts.attachments ?? []),
    member: { displayName: opts.author.username },
  };
}

let messageSeq = 1000;

export class FakeThread {
  readonly type = ChannelType.PublicThread;
  readonly guildId = GUILD_ID;
  readonly sent: unknown[] = [];
  readonly client = { user: { id: BOT_USER_ID, bot: true } };
  starter: FakeMessage | null = null;
  /** When set, send() rejects with this error (a Discord failure). */
  failSend: Error | null = null;
  readonly messages = {
    fetch: async (id?: string) => {
      if (this.starter && (id === undefined || id === this.starter.id)) return this.starter;
      throw new Error('Unknown Message');
    },
  };

  readonly id: string;
  name: string;
  readonly parentId: string;
  readonly ownerId: string;

  // Plain fields, not parameter properties: tsconfig has erasableSyntaxOnly.
  constructor(id: string, name: string, parentId: string, ownerId: string) {
    this.id = id;
    this.name = name;
    this.parentId = parentId;
    this.ownerId = ownerId;
  }

  isThread(): boolean {
    return true;
  }

  async send(options: unknown): Promise<{ id: string; channelId: string }> {
    if (this.failSend) throw this.failSend;
    this.sent.push(options);
    messageSeq += 1;
    return { id: String(messageSeq), channelId: this.id };
  }

  async fetchStarterMessage(): Promise<FakeMessage | null> {
    if (!this.starter) throw new Error('Unknown Message');
    return this.starter;
  }
}

export type ThreadCreateOptions = { name: string; message: Record<string, unknown> & { files?: unknown[] } };

export class FakeForum {
  readonly type = ChannelType.GuildForum;
  readonly guildId = GUILD_ID;
  readonly createCalls: ThreadCreateOptions[] = [];
  readonly created: FakeThread[] = [];
  /** Reject this many create calls that carry files (Discord refusing the upload), then accept. */
  failCreateWithFiles = 0;
  /** Reject every create call. */
  failCreate = false;
  private seq = 0;
  readonly threads = {
    create: async (options: ThreadCreateOptions): Promise<FakeThread> => {
      this.createCalls.push(options);
      const hasFiles = Array.isArray(options.message?.files) && options.message.files.length > 0;
      if (this.failCreate) throw new Error('Missing Permissions');
      if (hasFiles && this.failCreateWithFiles > 0) {
        this.failCreateWithFiles -= 1;
        throw new Error('Request entity too large');
      }
      this.seq += 1;
      const t = new FakeThread(`77000000000000000${this.seq}`, options.name, this.id, BOT_USER_ID);
      this.created.push(t);
      return t;
    },
  };

  readonly id: string;

  constructor(id: string = FORUM_ID) {
    this.id = id;
  }

  isThreadOnly(): boolean {
    return true;
  }
}

/** Guild and client channel managers that both resolve the forum, so the handler may use either. */
function channelManager(forum: FakeForum) {
  return {
    cache: new Collection<string, unknown>([[forum.id, forum]]),
    fetch: async (id: string) => (id === forum.id ? forum : null),
  };
}

// ---------------------------------------------------------------- interactions

export type InteractionCall = { method: string; options: unknown };

class AlreadyAcknowledged extends Error {
  override name = 'InteractionAlreadyReplied';
}
class NotAcknowledged extends Error {
  override name = 'InteractionNotReplied';
}

export class FakeInteraction {
  readonly calls: InteractionCall[] = [];
  deferred = false;
  replied = false;
  ephemeral: boolean | null = null;
  readonly guildId = GUILD_ID;
  readonly guild: { id: string; channels: ReturnType<typeof channelManager> };
  readonly client: { user: { id: string; bot: boolean }; channels: ReturnType<typeof channelManager> };
  readonly member: { displayName: string; user: FakeUser };
  readonly applicationId = '900000000000000001';
  readonly channelId = '1561007238103961000';
  readonly id = '880000000000000001';

  readonly kind: 'command' | 'modal' | 'button';
  readonly user: FakeUser;
  readonly forum: FakeForum;
  readonly extra: { customId?: string; commandName?: string; fields?: ModalSubmitFields; attachmentSizeLimit?: number };

  constructor(
    kind: 'command' | 'modal' | 'button',
    user: FakeUser,
    forum: FakeForum,
    extra: { customId?: string; commandName?: string; fields?: ModalSubmitFields; attachmentSizeLimit?: number },
  ) {
    this.kind = kind;
    this.user = user;
    this.forum = forum;
    this.extra = extra;
    this.guild = { id: GUILD_ID, channels: channelManager(forum) };
    this.client = { user: { id: BOT_USER_ID, bot: true }, channels: channelManager(forum) };
    this.member = { displayName: user.username, user };
  }

  get customId(): string | undefined {
    return this.extra.customId;
  }
  get commandName(): string | undefined {
    return this.extra.commandName;
  }
  get fields(): ModalSubmitFields | undefined {
    return this.extra.fields;
  }
  get attachmentSizeLimit(): number {
    return this.extra.attachmentSizeLimit ?? 10 * 1024 * 1024;
  }

  isModalSubmit(): boolean {
    return this.kind === 'modal';
  }
  isButton(): boolean {
    return this.kind === 'button';
  }
  isChatInputCommand(): boolean {
    return this.kind === 'command';
  }
  isCommand(): boolean {
    return this.kind === 'command';
  }
  isRepliable(): boolean {
    return true;
  }
  inGuild(): boolean {
    return true;
  }
  inCachedGuild(): boolean {
    return true;
  }

  private ack(method: string, options: unknown): void {
    if (this.deferred || this.replied) throw new AlreadyAcknowledged(`${method}: interaction already acknowledged`);
    this.calls.push({ method, options });
  }

  async deferReply(options?: unknown): Promise<void> {
    this.ack('deferReply', options);
    this.deferred = true;
    this.ephemeral = isEphemeral(options);
  }
  async deferUpdate(options?: unknown): Promise<void> {
    this.ack('deferUpdate', options);
    this.deferred = true;
  }
  async reply(options: unknown): Promise<void> {
    this.ack('reply', options);
    this.replied = true;
    this.ephemeral = isEphemeral(options);
  }
  async showModal(modal: unknown): Promise<void> {
    this.ack('showModal', modal);
    this.replied = true;
  }
  async editReply(options: unknown): Promise<{ id: string }> {
    if (!this.deferred && !this.replied) throw new NotAcknowledged('editReply before deferReply/reply');
    this.calls.push({ method: 'editReply', options });
    this.replied = true;
    return { id: 'reply' };
  }
  async followUp(options: unknown): Promise<{ id: string }> {
    if (!this.deferred && !this.replied) throw new NotAcknowledged('followUp before deferReply/reply');
    this.calls.push({ method: 'followUp', options });
    return { id: 'followup' };
  }

  /** What the player was shown (reply, editReply, followUp), in order. */
  answers(): InteractionCall[] {
    return this.calls.filter((c) => c.method === 'reply' || c.method === 'editReply' || c.method === 'followUp');
  }

  /** The last thing the player was shown, and whether only they could see it. */
  finalAnswer(): { options: unknown; ephemeral: boolean } | undefined {
    const list = this.answers();
    const last = list[list.length - 1];
    if (!last) return undefined;
    // editReply inherits the visibility chosen at deferReply/reply; followUp and reply carry their own flag.
    const ephemeral = last.method === 'editReply' ? this.ephemeral === true : isEphemeral(last.options);
    return { options: last.options, ephemeral };
  }
}

export function modalInteraction(opts: {
  user: FakeUser;
  forum: FakeForum;
  what: string;
  where?: string;
  file?: RawAttachment;
  attachmentSizeLimit?: number;
}): FakeInteraction {
  return new FakeInteraction('modal', opts.user, opts.forum, {
    customId: 'bug-modal',
    fields: bugModalFields(opts.what, opts.where ?? '', opts.file),
    attachmentSizeLimit: opts.attachmentSizeLimit ?? 10 * 1024 * 1024,
  });
}

export function commandInteraction(user: FakeUser, forum: FakeForum): FakeInteraction {
  return new FakeInteraction('command', user, forum, { commandName: 'bug' });
}

export function buttonInteraction(user: FakeUser, forum: FakeForum, customId: string): FakeInteraction {
  return new FakeInteraction('button', user, forum, { customId });
}

// ---------------------------------------------------------------- reading what was sent

export function isEphemeral(options: unknown): boolean {
  if (!options || typeof options !== 'object') return false;
  const o = options as { ephemeral?: unknown; flags?: unknown };
  if (o.ephemeral === true) return true;
  if (o.flags === undefined || o.flags === null) return false;
  try {
    return new MessageFlagsBitField(o.flags as never).has(MessageFlags.Ephemeral);
  } catch {
    return false;
  }
}

export type SentMessage = {
  content: string | undefined;
  embeds: Array<{ title?: string; description?: string; color?: number; [k: string]: unknown }>;
  buttons: Array<{ label?: string; url?: string; customId?: string; style?: number }>;
  files: unknown[];
  allowedMentions: unknown;
};

function plain(x: unknown): unknown {
  // Builders (EmbedBuilder, ActionRowBuilder, ButtonBuilder) serialise through toJSON; plain objects pass as is.
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/** Normalises any message option object (string, plain options, builders) to what Discord would receive. */
export function readMessage(options: unknown): SentMessage {
  if (typeof options === 'string') {
    return { content: options, embeds: [], buttons: [], files: [], allowedMentions: undefined };
  }
  const o = (options ?? {}) as Record<string, unknown>;
  const embeds = ((o['embeds'] as unknown[] | undefined) ?? []).map((e) => plain(e) as SentMessage['embeds'][number]);
  const rows = ((o['components'] as unknown[] | undefined) ?? []).map((r) => plain(r) as { components?: unknown[] });
  const buttons: SentMessage['buttons'] = [];
  for (const row of rows) {
    for (const c of row.components ?? []) {
      const b = c as Record<string, unknown>;
      const style = b['style'];
      buttons.push({
        label: b['label'] as string | undefined,
        url: b['url'] as string | undefined,
        customId: (b['custom_id'] ?? b['customId']) as string | undefined,
        style: typeof style === 'number' ? style : undefined,
      });
    }
  }
  return {
    content: typeof o['content'] === 'string' ? (o['content'] as string) : undefined,
    embeds,
    buttons,
    files: Array.isArray(o['files']) ? (o['files'] as unknown[]) : [],
    allowedMentions: o['allowedMentions'] ?? o['allowed_mentions'],
  };
}

/** True when the message cannot ping anyone: allowedMentions with an empty `parse` and no explicit ids. */
export function mentionsNobody(options: unknown): boolean {
  const am = readMessage(options).allowedMentions as
    | { parse?: unknown; users?: unknown[]; roles?: unknown[] }
    | undefined;
  if (!am || !Array.isArray(am.parse) || am.parse.length !== 0) return false;
  if (Array.isArray(am.users) && am.users.length > 0) return false;
  if (Array.isArray(am.roles) && am.roles.length > 0) return false;
  return true;
}

/** Every piece of text a reader sees in a message (content, embed title/description/fields/footer, labels). */
export function visibleText(options: unknown): string {
  const m = readMessage(options);
  const parts: string[] = [];
  if (m.content) parts.push(m.content);
  for (const e of m.embeds) parts.push(JSON.stringify(e));
  for (const b of m.buttons) parts.push(b.label ?? '');
  return parts.join('\n');
}
