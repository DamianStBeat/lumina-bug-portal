// design.md "bugCommand.ts" and brief rows 1, 3, 7: the /bug slash command, its modal, and what happens on submit.
// The worker is a real HTTP server (fake), the forum and the interaction are fakes that record what was sent.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bugCommandData, buildBugModal, handleBugCommand, handleBugModalSubmit } from '../src/bugCommand.ts';
import { errorTag, PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, deadBase, FakeWorker, PART_SIZE, REPORT_TOKEN } from './fakes/worker.ts';
import { fakeCdn, patternBytes } from './fakes/cdn.ts';
import {
  cdnUrl,
  commandInteraction,
  FakeForum,
  makeUser,
  mentionsNobody,
  modalInteraction,
  readMessage,
  type RawAttachment,
} from './fakes/discord.ts';
import { DISCORD_TOKEN, makeConfig, makeLogger, makeTempDir, removeDir, SITE_BASE, TRY_AGAIN } from './fakes/common.ts';

const MiB = 1024 * 1024;
const CODE = 'LUM-482193';
const PLAYER = makeUser('123456789012345678', 'skyler_77');
const WHAT = 'The boss stopped on the bridge and the wave never ended.';

let worker: FakeWorker;
let stateDir: string;
let forum: FakeForum;
let log: ReturnType<typeof makeLogger>;

before(async () => {
  worker = await FakeWorker.start();
  stateDir = await makeTempDir();
});
after(async () => {
  await worker.stop();
  await removeDir(stateDir);
});
beforeEach(() => {
  worker.requests.length = 0;
  worker.mode = 'ok';
  worker.override = undefined;
  worker.storage.reset();
  forum = new FakeForum();
  log = makeLogger();
});
afterEach(() => {
  // A report token, a key or a token in the logs would reach journald.
  const text = log.text();
  for (const secret of [REPORT_TOKEN, AGENT_KEY, DISCORD_TOKEN]) assert.ok(!text.includes(secret), 'secret in logs');
});

function deps(fetchImpl = fakeCdn({}).fetchImpl, base = worker.base, timeoutMs = 2000) {
  return {
    api: new PortalApi({ base, agentKey: AGENT_KEY, timeoutMs }),
    config: makeConfig(base, stateDir),
    log,
    fetchImpl,
  };
}

// The handlers take discord.js interaction types; the fakes carry only what they call (see fakes/discord.ts).
type Interaction = Parameters<typeof handleBugModalSubmit>[0];
type CommandInteraction = Parameters<typeof handleBugCommand>[0];

function plain(x: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
}

describe('/bug command and modal', () => {
  test('design: the guild command is /bug "Report a bug in Lumina"', () => {
    const data = plain(bugCommandData());
    assert.equal(data['name'], 'bug');
    assert.equal(data['description'], 'Report a bug in Lumina');
  });

  test('design: the modal has the three labelled fields of the mockup', () => {
    const modal = plain(buildBugModal());
    assert.equal(modal['custom_id'], 'bug-modal');
    assert.equal(modal['title'], '🐞 Report a bug');
    const labels = modal['components'] as Array<{ type: number; label: string; component: Record<string, unknown> }>;
    const byId = new Map(labels.map((l) => [l.component['custom_id'] as string, l]));

    const what = byId.get('what');
    assert.ok(what);
    assert.equal(what.type, 18);
    assert.equal(what.label, 'What happened?');
    assert.equal(what.component['style'], 2, 'paragraph');
    assert.equal(what.component['required'], true);
    assert.equal(what.component['max_length'], 2000);
    assert.equal(what.component['placeholder'], 'The boss stopped on the bridge and the wave never ended.');

    const where = byId.get('where');
    assert.ok(where);
    assert.equal(where.label, 'Where in the game?');
    assert.equal(where.component['style'], 1, 'short');
    assert.equal(where.component['required'] ?? false, false);
    assert.equal(where.component['max_length'], 100);
    assert.equal(where.component['placeholder'], 'Match, Lobby, Shop, Crates, Clan, Something else');

    const file = byId.get('file');
    assert.ok(file);
    assert.equal(file.label, 'Video or picture');
    assert.equal(file.component['type'], 19, 'file upload');
    assert.equal(file.component['min_values'], 0);
    assert.equal(file.component['max_values'], 1);
    assert.equal(file.component['required'] ?? true, false, 'the file is optional');
  });

  test('design: /bug opens the modal (no reply first: a modal must be the first answer)', async () => {
    const i = commandInteraction(PLAYER, forum);
    await handleBugCommand(i as unknown as CommandInteraction, deps());
    assert.equal(i.calls.length, 1);
    assert.equal(i.calls[0]!.method, 'showModal');
    assert.equal(plain(i.calls[0]!.options)['custom_id'], 'bug-modal');
  });

  test('row 1: 18 MB video -> forum post, code reply in the thread, video archived, ephemeral answer with link', async () => {
    const video: RawAttachment = { id: '900', name: 'boss-bridge.mp4', size: 18 * MiB, contentType: 'video/mp4' };
    const bytes = patternBytes(18 * MiB);
    const cdn = fakeCdn({ [cdnUrl(video)]: bytes });
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT, where: 'Match', file: video, attachmentSizeLimit: 10 * MiB });

    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl)));

    // Deferred first and only visible to the player (Discord's 3 s rule).
    assert.equal(i.calls[0]!.method, 'deferReply');
    assert.equal(i.ephemeral, true);

    // The report reached the worker as a Discord report from this player.
    const creates = worker.find('POST', '/agent/reports');
    assert.equal(creates.length, 1);
    const body = creates[0]!.json as Record<string, unknown>;
    assert.equal(body['source'], 'discord');
    assert.equal(body['discordUserId'], PLAYER.id);
    assert.equal(typeof body['discordName'], 'string');
    assert.ok((body['discordName'] as string).length > 0);
    assert.equal(body['what'], WHAT);
    // fix round 1, decision 1: the typed "Match" reaches the worker as CONTRACT's where_area value.
    assert.equal(body['where'], 'match');

    // One forum post with the player's text; the 18 MB file is over this server's limit, so text only.
    assert.equal(forum.createCalls.length, 1);
    const post = forum.createCalls[0]!;
    assert.equal(post.name, WHAT);
    assert.ok((readMessage(post.message).content ?? '').includes(WHAT));
    assert.equal(readMessage(post.message).files.length, 0, 'over attachmentSizeLimit: not attached');
    assert.ok(mentionsNobody(post.message));

    // The bot's "We have it" embed in that thread, and the thread linked to the report.
    const thread = forum.created[0]!;
    assert.equal(thread.sent.length, 1);
    const reply = readMessage(thread.sent[0]);
    assert.equal(reply.embeds[0]!.title, `We have it · ${CODE}`);
    assert.ok(reply.buttons.some((b) => b.customId === `status:${CODE}`));
    assert.ok(mentionsNobody(thread.sent[0]));
    const links = worker.find('POST', `/agent/reports/${CODE}/discord`);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0]!.json, { threadId: thread.id });

    // The video is in the archive anyway: downloaded from the CDN and uploaded in 16 MiB parts.
    assert.ok(cdn.calls.includes(cdnUrl(video)));
    const up = worker.find('POST', `/reports/${CODE}/attachments`);
    assert.equal(up.length, 1);
    assert.deepEqual(up[0]!.json, { filename: 'boss-bridge.mp4', size: 18 * MiB, mime: 'video/mp4' });
    const parts = worker.storage.puts();
    assert.deepEqual(
      parts.map((p) => p.body.length),
      [PART_SIZE, 18 * MiB - PART_SIZE],
    );
    assert.equal(worker.find('POST', /\/complete$/).length, 1);

    // The player's answer: only for them, with the code and the "Add a bigger video" link.
    const final = i.finalAnswer();
    assert.ok(final);
    assert.equal(final.ephemeral, true);
    const answer = readMessage(final.options);
    assert.equal(answer.embeds[0]!.title, `We have it · ${CODE}`);
    assert.deepEqual(
      answer.buttons.map((b) => [b.label, b.url]),
      [['Add a bigger video', `${SITE_BASE}/add?code=${CODE}`]],
    );
    assert.ok(mentionsNobody(final.options));

    // Order: report first, then the post, then the link.
    const idx = (r: unknown) => worker.requests.indexOf(r as (typeof worker.requests)[number]);
    assert.ok(idx(creates[0]) < idx(links[0]));

    // No full player text in the logs (codes, ids and error names only).
    assert.ok(!log.text().includes(WHAT));
  });

  test('row 1: a picture within the limit is attached to the forum post too', async () => {
    const pic: RawAttachment = { id: '901', name: 'bridge.png', size: 2 * MiB, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(pic)]: patternBytes(2 * MiB) });
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT, file: pic, attachmentSizeLimit: 10 * MiB });
    await handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl));
    assert.equal(forum.createCalls.length, 1);
    assert.equal(readMessage(forum.createCalls[0]!.message).files.length, 1);
    assert.equal(worker.find('POST', `/reports/${CODE}/attachments`).length, 1, 'and archived');
  });

  for (const [label, size, attached] of [
    ['exactly at', 1000, 1],
    ['one byte over', 1001, 0],
  ] as const) {
    test(`row 1: a file ${label} attachmentSizeLimit is ${attached ? '' : 'not '}attached to the post`, async () => {
      const pic: RawAttachment = { id: '902', name: 'p.png', size, contentType: 'image/png' };
      const cdn = fakeCdn({ [cdnUrl(pic)]: patternBytes(size) });
      const i = modalInteraction({ user: PLAYER, forum, what: WHAT, file: pic, attachmentSizeLimit: 1000 });
      await handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl));
      assert.equal(readMessage(forum.createCalls[0]!.message).files.length, attached);
      assert.equal(worker.find('POST', `/reports/${CODE}/attachments`).length, 1, 'archived either way');
    });
  }

  test('row 1: Discord refusing the file -> the post is retried once without it', async () => {
    forum.failCreateWithFiles = 1;
    const pic: RawAttachment = { id: '903', name: 'p.png', size: 500, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(pic)]: patternBytes(500) });
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT, file: pic, attachmentSizeLimit: 10 * MiB });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl)));
    assert.equal(forum.createCalls.length, 2);
    assert.equal(readMessage(forum.createCalls[1]!.message).files.length, 0);
    assert.equal(forum.created.length, 1);
    assert.equal(readMessage(i.finalAnswer()!.options).embeds[0]!.title, `We have it · ${CODE}`);
  });

  test('row 1: no file at all -> post and answer, nothing uploaded', async () => {
    const cdn = fakeCdn({});
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl));
    assert.equal(forum.createCalls.length, 1);
    assert.equal(cdn.calls.length, 0);
    assert.equal(worker.find('POST', /\/attachments$/).length, 0);
    assert.equal(readMessage(i.finalAnswer()!.options).embeds[0]!.title, `We have it · ${CODE}`);
  });

  test('row 3: @everyone and **grassetto** -> no mention, shown literally (escaped) in the post', async () => {
    const hostile = '@everyone **grassetto** look\nsecond line';
    const i = modalInteraction({ user: PLAYER, forum, what: hostile });
    await handleBugModalSubmit(i as unknown as Interaction, deps());
    const post = forum.createCalls[0]!;
    const content = (readMessage(post.message).content ?? '').replaceAll('​', '');
    assert.ok(content.includes('\\*\\*grassetto\\*\\*'), content);
    assert.ok(!content.includes('**grassetto**'), content);
    assert.ok(content.includes('@everyone'), 'shown, not removed');
    assert.ok(mentionsNobody(post.message), 'cannot ping');
    // fix round 1, decision 7: a post title does not render markdown, so the name is the first line as typed.
    assert.equal(post.name, '@everyone **grassetto** look');
    for (const sent of forum.created[0]!.sent) assert.ok(mentionsNobody(sent));
    for (const c of i.answers()) assert.ok(mentionsNobody(c.options));
    // The archive keeps what the player typed; escaping is for Discord only.
    assert.equal((worker.find('POST', '/agent/reports')[0]!.json as { what: string }).what, hostile);
  });

  test('design: a long first line becomes a thread name of at most 100 chars', async () => {
    const i = modalInteraction({ user: PLAYER, forum, what: 'x'.repeat(1999) });
    await handleBugModalSubmit(i as unknown as Interaction, deps());
    const post = forum.createCalls[0]!;
    assert.ok(post.name.length > 0 && post.name.length <= 100, `name ${post.name.length}`);
    assert.ok((readMessage(post.message).content ?? '').length <= 2000);
  });

  test('row 7: worker unreachable -> "Couldn\'t send it. Try again in a minute.", nothing posted, no throw', async () => {
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps(undefined, await deadBase())));
    const final = i.finalAnswer();
    assert.ok(final);
    assert.equal(readMessage(final.options).content, TRY_AGAIN);
    assert.equal(final.ephemeral, true);
    assert.ok(mentionsNobody(final.options));
    assert.equal(forum.createCalls.length, 0, 'nothing posted');
  });

  test('row 7: worker hangs -> the same answer once the timeout fires, nothing posted', async () => {
    worker.mode = 'hang';
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps(undefined, worker.base, 200)));
    assert.equal(readMessage(i.finalAnswer()!.options).content, TRY_AGAIN);
    assert.equal(forum.createCalls.length, 0);
  });

  test('row 7: worker answers 503 -> the same answer, nothing posted', async () => {
    worker.mode = 'error';
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps()));
    assert.equal(readMessage(i.finalAnswer()!.options).content, TRY_AGAIN);
    assert.equal(forum.createCalls.length, 0);
  });

  test('design: a failure after the report exists (link fails) still gives the player the code', async () => {
    worker.override = (r) => (r.path.endsWith('/discord') ? { status: 500, body: { error: 'internal' } } : undefined);
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps()));
    const answer = readMessage(i.finalAnswer()!.options);
    assert.equal(answer.embeds[0]!.title, `We have it · ${CODE}`);
    assert.ok(log.lines.some((l) => l.level === 'warn' || l.level === 'error'), 'the failure is logged');
  });

  test('design: the forum post failing (Discord) still gives the player the code', async () => {
    forum.failCreate = true;
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps()));
    const answer = readMessage(i.finalAnswer()!.options);
    assert.equal(answer.embeds[0]!.title, `We have it · ${CODE}`);
    assert.ok(i.finalAnswer()!.ephemeral);
  });
});

/** The values of a log line's data (keys are the builder's; the specs look for what the line carries). */
function logValues(data: unknown): unknown[] {
  return data && typeof data === 'object' ? Object.values(data as Record<string, unknown>) : [];
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  for (let t = 0; t < ms && !cond(); t += 5) await new Promise((r) => setTimeout(r, 5));
  return cond();
}

function createdBody(): Record<string, unknown> {
  const creates = worker.find('POST', '/agent/reports');
  assert.equal(creates.length, 1, 'one report created');
  return creates[0]!.json as Record<string, unknown>;
}

describe('fix round 1: /bug modal submit', () => {
  // Decision 1: the typed "Where in the game?" is mapped to CONTRACT's where_area; the worker refuses anything else.
  for (const [typed, area] of [
    ['Match', 'match'],
    ['  LOBBY  ', 'lobby'],
    ['shop', 'shop'],
    ['Clan', 'clan'],
    ['crate', 'crates'],
    ['Crates', 'crates'],
    ['Something else', 'other'],
    ['other', 'other'],
    ['Match.', 'match'],
    ['Something else.', 'other'],
  ] as const) {
    test(`fix1-1: where "${typed}" reaches the worker as "${area}", the text unchanged`, async () => {
      const i = modalInteraction({ user: PLAYER, forum, what: WHAT, where: typed });
      await handleBugModalSubmit(i as unknown as Interaction, deps());
      const body = createdBody();
      assert.equal(body['where'], area);
      assert.equal(body['what'], WHAT);
      assert.equal(readMessage(i.finalAnswer()!.options).embeds[0]?.title, `We have it · ${CODE}`);
    });
  }

  for (const typed of ['on the Bridge', 'match lobby', 'shops']) {
    test(`fix1-1: where "${typed}" (not an area) -> "other", the typed text kept at the end of what`, async () => {
      const i = modalInteraction({ user: PLAYER, forum, what: WHAT, where: typed });
      await handleBugModalSubmit(i as unknown as Interaction, deps());
      const body = createdBody();
      assert.equal(body['where'], 'other');
      assert.equal(body['what'], `${WHAT}\n\nWhere: ${typed}`);
      assert.equal(readMessage(i.finalAnswer()!.options).embeds[0]?.title, `We have it · ${CODE}`);
    });
  }

  for (const typed of ['', '   ']) {
    test(`fix1-1: where ${JSON.stringify(typed)} (left empty) -> no where field at all`, async () => {
      const i = modalInteraction({ user: PLAYER, forum, what: WHAT, where: typed });
      await handleBugModalSubmit(i as unknown as Interaction, deps());
      const body = createdBody();
      assert.ok(!('where' in body), JSON.stringify(body));
      assert.equal(body['what'], WHAT);
    });
  }

  test('fix1-1: the "Where:" suffix is cut first so the total stays 2000; the player text is never cut', async () => {
    const what = 'a'.repeat(1990);
    const i = modalInteraction({ user: PLAYER, forum, what, where: 'on the bridge' });
    await handleBugModalSubmit(i as unknown as Interaction, deps());
    const body = createdBody();
    assert.equal(body['where'], 'other');
    assert.equal(body['what'], what + '\n\nWhere: on the bridge'.slice(0, 10));
    assert.equal((body['what'] as string).length, 2000);
  });

  test('fix1-1: a 2000-character text with an unknown place keeps the whole text and no suffix', async () => {
    const what = 'b'.repeat(2000);
    const i = modalInteraction({ user: PLAYER, forum, what, where: 'on the bridge' });
    await handleBugModalSubmit(i as unknown as Interaction, deps());
    const body = createdBody();
    assert.equal(body['where'], 'other');
    assert.equal(body['what'], what);
  });

  test('fix1-1: a worker 400 at the create is logged with its code and the player reads the try-again text', async () => {
    worker.override = (r) =>
      r.method === 'POST' && r.path === '/agent/reports' ? { status: 400, body: { error: 'invalid_where' } } : undefined;
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT, where: 'Match' });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps()));
    const final = i.finalAnswer();
    assert.ok(final);
    assert.equal(readMessage(final.options).content, TRY_AGAIN);
    assert.equal(final.ephemeral, true);
    assert.equal(forum.createCalls.length, 0);
    const tag = errorTag(new PortalError('invalid_where', 400));
    assert.ok(log.lines.some((l) => logValues(l.data).includes(tag)), log.text());
  });

  // Decision 5: the forum re-post carries the file only up to min(attachmentSizeLimit, 25 MiB), one at a time.
  for (const [label, size, attached] of [
    ['exactly 25 MiB', 25 * MiB, 1],
    ['25 MiB + 1 byte', 25 * MiB + 1, 0],
  ] as const) {
    test(`fix1-5: on a 100 MiB server a file of ${label} is ${attached ? '' : 'not '}re-posted; the archive copy runs`, async () => {
      const video: RawAttachment = { id: '910', name: 'clip.mp4', size, contentType: 'video/mp4' };
      // The CDN link answers 404: the archive copy is attempted without moving 25 MiB through the test.
      const cdn = fakeCdn({}, new Set([cdnUrl(video)]));
      const i = modalInteraction({ user: PLAYER, forum, what: WHAT, file: video, attachmentSizeLimit: 100 * MiB });
      await handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl));
      assert.equal(forum.createCalls.length, 1);
      assert.equal(readMessage(forum.createCalls[0]!.message).files.length, attached);
      assert.ok(cdn.calls.includes(cdnUrl(video)), 'archive copy attempted either way');
    });
  }

  test('fix1-5: while one re-post is in flight, a second report posts text only and still archives its file', async () => {
    let release!: () => void;
    forum.holdCreateWithFiles = new Promise<void>((r) => (release = r));
    const a: RawAttachment = { id: '920', name: 'a.png', size: 500, contentType: 'image/png' };
    const b: RawAttachment = { id: '921', name: 'b.png', size: 600, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(a)]: patternBytes(500), [cdnUrl(b)]: patternBytes(600) });
    const first = modalInteraction({ user: PLAYER, forum, what: WHAT, file: a, attachmentSizeLimit: 10 * MiB });
    const second = modalInteraction({ user: PLAYER, forum, what: 'Second report.', file: b, attachmentSizeLimit: 10 * MiB });

    const running1 = handleBugModalSubmit(first as unknown as Interaction, deps(cdn.fetchImpl));
    assert.ok(await waitFor(() => forum.createCalls.length === 1), 'first post in flight');
    const running2 = handleBugModalSubmit(second as unknown as Interaction, deps(cdn.fetchImpl));
    const secondPosted = await waitFor(() => forum.createCalls.length === 2);
    release();
    await Promise.all([running1, running2]);

    assert.ok(secondPosted, 'the second post did not wait for the first upload');
    assert.equal(readMessage(forum.createCalls[0]!.message).files.length, 1, 'first carries its file');
    assert.equal(readMessage(forum.createCalls[1]!.message).files.length, 0, 'second: text only while busy');
    assert.ok(cdn.calls.includes(cdnUrl(b)), 'the second file is archived anyway');
    assert.equal(readMessage(second.finalAnswer()!.options).embeds[0]?.title, `We have it · ${CODE}`);

    // The slot is free again: the next report re-posts its file.
    forum.holdCreateWithFiles = null;
    const third = modalInteraction({ user: PLAYER, forum, what: WHAT, file: a, attachmentSizeLimit: 10 * MiB });
    await handleBugModalSubmit(third as unknown as Interaction, deps(cdn.fetchImpl));
    assert.equal(readMessage(forum.createCalls[2]!.message).files.length, 1, 'slot released after the re-post');
  });

  test('fix1-5: a refused re-post frees the slot (the next report re-posts its file)', async () => {
    forum.failCreateWithFiles = 1;
    const a: RawAttachment = { id: '930', name: 'a.png', size: 500, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(a)]: patternBytes(500) });
    const first = modalInteraction({ user: PLAYER, forum, what: WHAT, file: a, attachmentSizeLimit: 10 * MiB });
    await handleBugModalSubmit(first as unknown as Interaction, deps(cdn.fetchImpl));
    const second = modalInteraction({ user: PLAYER, forum, what: WHAT, file: a, attachmentSizeLimit: 10 * MiB });
    await handleBugModalSubmit(second as unknown as Interaction, deps(cdn.fetchImpl));
    const last = forum.createCalls[forum.createCalls.length - 1]!;
    assert.equal(readMessage(last.message).files.length, 1);
  });

  // Decision 7: the thread name is the first line as typed: control characters removed, cut to 100, no escaping.
  for (const [label, what, name] of [
    ['markdown is kept', '**grassetto** _look_ @everyone\nsecond line', '**grassetto** _look_ @everyone'],
    ['control characters are removed', 'Boss\u0007 stuck\r\nmore', 'Boss stuck'],
    ['a first line of control characters falls back', '\u0007\u0007\nsecond line', 'Bug report'],
    ['exactly 100 characters stay whole', '*'.repeat(100), '*'.repeat(100)],
  ] as const) {
    test(`fix1-7: thread name, ${label}`, async () => {
      const i = modalInteraction({ user: PLAYER, forum, what });
      await handleBugModalSubmit(i as unknown as Interaction, deps());
      assert.equal(forum.createCalls.length, 1);
      assert.equal(forum.createCalls[0]!.name, name);
    });
  }

  test('fix1-7: a 101-character first line is cut to 100; the message content stays escaped', async () => {
    const i = modalInteraction({ user: PLAYER, forum, what: '*'.repeat(101) });
    await handleBugModalSubmit(i as unknown as Interaction, deps());
    const post = forum.createCalls[0]!;
    assert.ok(post.name.length <= 100 && post.name.startsWith('*'.repeat(90)), post.name);
    assert.ok(!post.name.includes('\\'), 'no escape backslash in the name');
    assert.ok((readMessage(post.message).content ?? '').startsWith('\\*'), 'content escaped');
  });

  // Decision 9: a failed archive copy is logged with its error tag (no secret: afterEach checks the logs).
  test('fix1-9: a failed archive upload is logged with the code and the error tag', async () => {
    worker.override = (r) =>
      r.method === 'POST' && r.path === `/reports/${CODE}/attachments` ? { status: 500, body: { error: 'internal' } } : undefined;
    const pic: RawAttachment = { id: '940', name: 'p.png', size: 500, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(pic)]: patternBytes(500) });
    const i = modalInteraction({ user: PLAYER, forum, what: WHAT, file: pic, attachmentSizeLimit: 10 * MiB });
    await assert.doesNotReject(handleBugModalSubmit(i as unknown as Interaction, deps(cdn.fetchImpl)));
    const tag = errorTag(new PortalError('internal', 500));
    const lines = log.lines.filter((l) => logValues(l.data).includes(tag));
    assert.equal(lines.length, 1, log.text());
    assert.ok(logValues(lines[0]!.data).includes(CODE), 'the line names the report');
    assert.notEqual(lines[0]!.level, 'info');
  });
});
