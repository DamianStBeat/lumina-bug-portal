// design.md "forumPost.ts" and brief rows 2, 3, 4, 7, 8: a new post in the bug forum becomes a report.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleThreadCreate } from '../src/forumPost.ts';
import { errorTag, PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, deadBase, FakeWorker, REPORT_TOKEN } from './fakes/worker.ts';
import { fakeCdn, patternBytes } from './fakes/cdn.ts';
import {
  cdnUrl,
  FakeThread,
  isEphemeral,
  makeMessage,
  makeUser,
  mentionsNobody,
  readMessage,
  visibleText,
  type FakeUser,
  type RawAttachment,
} from './fakes/discord.ts';
import {
  BOT_USER_ID,
  DISCORD_TOKEN,
  FORUM_ID,
  makeConfig,
  makeLogger,
  makeTempDir,
  removeDir,
  SITE_BASE,
  TRY_AGAIN,
} from './fakes/common.ts';

const CODE = 'LUM-482193';
const PLAYER = makeUser('123456789012345678', 'skyler_77');
const TITLE = 'The boss stopped on the bridge';
const TEXT = 'The boss stopped on the bridge and the wave never ended.';

let worker: FakeWorker;
let stateDir: string;
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
  log = makeLogger();
});
afterEach(() => {
  const text = log.text();
  for (const secret of [REPORT_TOKEN, AGENT_KEY, DISCORD_TOKEN]) assert.ok(!text.includes(secret), 'secret in logs');
});

function deps(fetchImpl = fakeCdn({}).fetchImpl, base = worker.base) {
  return {
    api: new PortalApi({ base, agentKey: AGENT_KEY, timeoutMs: 2000 }),
    config: makeConfig(base, stateDir),
    log,
    fetchImpl,
  };
}

type Thread = Parameters<typeof handleThreadCreate>[0];

function post(opts: {
  author?: FakeUser;
  content?: string;
  attachments?: RawAttachment[];
  webhookId?: string | null;
  parentId?: string;
  name?: string;
}): FakeThread {
  const author = opts.author ?? PLAYER;
  const t = new FakeThread('770000000000000555', opts.name ?? TITLE, opts.parentId ?? FORUM_ID, author.id);
  t.starter = makeMessage({
    channelId: t.id,
    content: opts.content ?? TEXT,
    author,
    webhookId: opts.webhookId ?? null,
    attachments: opts.attachments ?? [],
  });
  return t;
}

async function run(t: FakeThread, newlyCreated = true, d = deps()): Promise<void> {
  // The fake carries only what the handler calls; see fakes/discord.ts.
  await handleThreadCreate(t as unknown as Thread, newlyCreated, d);
}

describe('new forum post', () => {
  test('row 2: a post with an image -> report created, image copied, "We have it" in the thread', async () => {
    const img: RawAttachment = { id: '600', name: 'bridge.png', size: 4000, contentType: 'image/png' };
    const bytes = patternBytes(4000, 9);
    const cdn = fakeCdn({ [cdnUrl(img)]: bytes });
    const t = post({ attachments: [img] });

    await assert.doesNotReject(run(t, true, deps(cdn.fetchImpl)));

    const creates = worker.find('POST', '/agent/reports');
    assert.equal(creates.length, 1);
    const body = creates[0]!.json as Record<string, unknown>;
    assert.equal(body['source'], 'discord');
    assert.equal(body['title'], TITLE);
    assert.equal(body['what'], TEXT);
    assert.equal(body['threadId'], t.id);
    assert.equal(body['discordUserId'], PLAYER.id);
    assert.equal(typeof body['discordName'], 'string');

    const up = worker.find('POST', `/reports/${CODE}/attachments`);
    assert.equal(up.length, 1);
    assert.deepEqual(up[0]!.json, { filename: 'bridge.png', size: 4000, mime: 'image/png' });
    const parts = worker.storage.puts();
    assert.equal(parts[0]?.part, 1);
    assert.ok(Buffer.from(bytes).equals(parts[0]!.body), 'the image bytes reached the archive');
    assert.equal(worker.find('POST', /\/complete$/).length, 1);

    assert.equal(t.sent.length, 1);
    const reply = readMessage(t.sent[0]);
    assert.equal(reply.embeds[0]!.title, `We have it · ${CODE}`);
    assert.deepEqual(
      reply.buttons.map((b) => b.label),
      ['Add a bigger video', 'See status'],
    );
    assert.equal(reply.buttons[0]!.url, `${SITE_BASE}/add?code=${CODE}`);
    assert.equal(reply.buttons[1]!.customId, `status:${CODE}`);
    assert.ok(mentionsNobody(t.sent[0]));
    assert.ok(!log.text().includes(TEXT), 'no player text in the logs');
  });

  test('row 2: a post with an empty first message uses the title as the text', async () => {
    const t = post({ content: '' });
    await run(t);
    const body = worker.find('POST', '/agent/reports')[0]!.json as Record<string, unknown>;
    assert.equal(body['what'], TITLE);
    assert.equal(readMessage(t.sent[0]).embeds[0]!.title, `We have it · ${CODE}`);
  });

  test('row 3: @everyone and **grassetto** in the post -> the reply pings nobody and echoes none of it', async () => {
    const hostile = '@everyone **grassetto**';
    const t = post({ content: hostile, name: `@everyone **grassetto** title` });
    await run(t);
    assert.equal(t.sent.length, 1);
    assert.ok(mentionsNobody(t.sent[0]));
    const seen = visibleText(t.sent[0]);
    assert.ok(!seen.includes('**grassetto**'), seen);
    assert.ok(!seen.includes('@everyone'), seen);
    assert.equal((worker.find('POST', '/agent/reports')[0]!.json as { what: string }).what, hostile, 'stored as typed');
  });

  test('row 4: an .exe attachment is not copied; the report is created and answered anyway', async () => {
    const exe: RawAttachment = { id: '601', name: 'cheat.exe', size: 9000, contentType: 'application/x-msdownload' };
    const cdn = fakeCdn({ [cdnUrl(exe)]: patternBytes(9000) });
    const t = post({ attachments: [exe] });
    await assert.doesNotReject(run(t, true, deps(cdn.fetchImpl)));
    assert.equal(worker.find('POST', '/agent/reports').length, 1);
    assert.equal(cdn.calls.length, 0, 'never downloaded');
    assert.equal(worker.find('POST', /\/attachments$/).length, 0, 'never uploaded');
    assert.equal(readMessage(t.sent[0]).embeds[0]!.title, `We have it · ${CODE}`);
  });

  test('row 4: .exe beside a video -> only the video is copied', async () => {
    const exe: RawAttachment = { id: '602', name: 'cheat.exe', size: 9000, contentType: 'application/x-msdownload' };
    const mp4: RawAttachment = { id: '603', name: 'clip.mp4', size: 3000, contentType: 'video/mp4' };
    const cdn = fakeCdn({ [cdnUrl(exe)]: patternBytes(9000), [cdnUrl(mp4)]: patternBytes(3000) });
    const t = post({ attachments: [exe, mp4] });
    await run(t, true, deps(cdn.fetchImpl));
    assert.deepEqual(cdn.calls, [cdnUrl(mp4)]);
    const up = worker.find('POST', `/reports/${CODE}/attachments`);
    assert.equal(up.length, 1);
    assert.equal((up[0]!.json as { filename: string }).filename, 'clip.mp4');
  });

  test('row 7: worker unreachable -> plain "Couldn\'t send it. Try again in a minute." in the thread, no throw', async () => {
    const t = post({});
    await assert.doesNotReject(run(t, true, deps(undefined, await deadBase())));
    assert.equal(t.sent.length, 1);
    const m = readMessage(t.sent[0]);
    assert.equal(m.content, TRY_AGAIN);
    assert.equal(m.embeds.length, 0);
    assert.ok(!isEphemeral(t.sent[0]), 'a thread message, not an interaction answer');
    assert.ok(mentionsNobody(t.sent[0]));
  });

  test('row 7: worker 503 -> the same message', async () => {
    worker.mode = 'error';
    const t = post({});
    await assert.doesNotReject(run(t));
    assert.equal(readMessage(t.sent[0]).content, TRY_AGAIN);
  });

  test('row 7: Discord refusing the reply does not crash the handler', async () => {
    const t = post({});
    t.failSend = new Error('Missing Permissions');
    await assert.doesNotReject(run(t));
    assert.equal(worker.find('POST', '/agent/reports').length, 1);
  });

  test('design: starter message not available yet -> no throw', async () => {
    const t = post({});
    t.starter = null;
    await assert.doesNotReject(run(t));
  });

  test("row 8: the bot's own post in the forum is ignored", async () => {
    const t = post({ author: makeUser(BOT_USER_ID, 'Lumina Bugs', true), content: 'Bug report: Boss stuck' });
    await assert.doesNotReject(run(t));
    assert.equal(worker.requests.length, 0);
    assert.equal(t.sent.length, 0);
  });

  test('row 8: a post by another bot is ignored', async () => {
    const t = post({ author: makeUser('555555555555555555', 'SomeBot', true) });
    await run(t);
    assert.equal(worker.requests.length, 0);
    assert.equal(t.sent.length, 0);
  });

  test('row 8: a webhook post (the old game webhook) is ignored', async () => {
    const t = post({ author: makeUser('666666666666666666', 'Lumina Game'), webhookId: '666666666666666666' });
    await run(t);
    assert.equal(worker.requests.length, 0);
    assert.equal(t.sent.length, 0);
  });

  test('design: a thread that is not newly created (cache load, unarchive) is ignored', async () => {
    const t = post({});
    await run(t, false);
    assert.equal(worker.requests.length, 0);
    assert.equal(t.sent.length, 0);
  });

  test('design: a new thread in another channel is ignored', async () => {
    const t = post({ parentId: '999999999999999999' });
    await run(t);
    assert.equal(worker.requests.length, 0);
    assert.equal(t.sent.length, 0);
  });
});

describe('fix round 1: new forum post', () => {
  // Decision 9: each failed archive copy is logged with its error tag, not only counted.
  test('fix1-9: two failed uploads -> two log lines, each with the code and the error tag', async () => {
    worker.override = (r) =>
      r.method === 'POST' && r.path === `/reports/${CODE}/attachments` ? { status: 500, body: { error: 'internal' } } : undefined;
    const a: RawAttachment = { id: '610', name: 'a.png', size: 400, contentType: 'image/png' };
    const b: RawAttachment = { id: '611', name: 'b.mp4', size: 700, contentType: 'video/mp4' };
    const cdn = fakeCdn({ [cdnUrl(a)]: patternBytes(400), [cdnUrl(b)]: patternBytes(700) });
    const t = post({ attachments: [a, b] });
    await assert.doesNotReject(run(t, true, deps(cdn.fetchImpl)));
    assert.equal(t.sent.length, 1, 'the player was answered');
    const tag = errorTag(new PortalError('internal', 500));
    const values = (d: unknown) => (d && typeof d === 'object' ? Object.values(d as Record<string, unknown>) : []);
    const lines = log.lines.filter((l) => values(l.data).includes(tag));
    assert.equal(lines.length, 2, log.text());
    for (const l of lines) {
      assert.ok(values(l.data).includes(CODE), 'names the report');
      assert.notEqual(l.level, 'info');
    }
  });

  test('fix1-9: a successful copy logs no failure line', async () => {
    const a: RawAttachment = { id: '612', name: 'a.png', size: 400, contentType: 'image/png' };
    const cdn = fakeCdn({ [cdnUrl(a)]: patternBytes(400) });
    await run(post({ attachments: [a] }), true, deps(cdn.fetchImpl));
    assert.ok(!log.lines.some((l) => l.level !== 'info'), log.text());
  });
});
