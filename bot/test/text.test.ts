// design.md "text.ts": every string the player sees, exactly as the approved mockup
// (plan/preview/shots/discord-thread.png), every message with allowedMentions { parse: [] }, player text escaped.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import { fixed, gameReportPost, sameBug, sentReply, statusReply, tryAgain, weHaveIt } from '../src/text.ts';
import { isEphemeral, mentionsNobody, readMessage } from './fakes/discord.ts';
import { SITE_BASE, TRY_AGAIN } from './fakes/common.ts';

const CODE = 'LUM-482193';
// The report row shape is the builder's (text.ts); the specs pass the D1 columns they care about.
type GameRow = Parameters<typeof gameReportPost>[0];
const row = (r: Record<string, unknown>): GameRow => r as unknown as GameRow;
type PublicStatus = Parameters<typeof statusReply>[1];
type OriginalStatus = Parameters<typeof sameBug>[2];

const HOSTILE = '@everyone **grassetto** <@123> ||spoiler|| [link](https://evil.test)';

describe('text', () => {
  test('row 2: weHaveIt is the amber "We have it" embed with the two buttons', () => {
    const msg = weHaveIt(CODE, SITE_BASE);
    const m = readMessage(msg);
    assert.equal(m.embeds.length, 1);
    assert.equal(m.embeds[0]!.title, `We have it · ${CODE}`);
    assert.equal(
      m.embeds[0]!.description,
      "The team and our checker look at it next. We'll write here when it changes.\n\n" +
        'Video bigger than Discord allows? Add it on our site with the same code.',
    );
    assert.equal(m.embeds[0]!.color, 0xf0b232);
    assert.equal(m.buttons.length, 2);
    assert.deepEqual(m.buttons[0], {
      label: 'Add a bigger video',
      url: `${SITE_BASE}/add?code=${CODE}`,
      customId: undefined,
      style: ButtonStyle.Link,
    });
    assert.equal(m.buttons[1]!.label, 'See status');
    assert.equal(m.buttons[1]!.customId, `status:${CODE}`);
    assert.equal(m.buttons[1]!.style, ButtonStyle.Secondary);
    assert.ok(mentionsNobody(msg));
  });

  test('row 1: sentReply is ephemeral, carries the code and only the link button', () => {
    const msg = sentReply(CODE, SITE_BASE);
    const m = readMessage(msg);
    assert.ok(isEphemeral(msg), 'ephemeral');
    assert.equal(m.embeds[0]!.title, `We have it · ${CODE}`);
    assert.equal(m.buttons.length, 1);
    assert.equal(m.buttons[0]!.label, 'Add a bigger video');
    assert.equal(m.buttons[0]!.url, `${SITE_BASE}/add?code=${CODE}`);
    assert.ok(mentionsNobody(msg));
  });

  test('row 5: fixed is the green embed with the note, the update line and the thanks', () => {
    const msg = fixed(CODE, 'The boss now finishes the bridge.', 'skyler_77');
    const m = readMessage(msg);
    assert.equal(m.embeds[0]!.title, `Fixed · ${CODE}`);
    assert.equal(
      m.embeds[0]!.description,
      "The boss now finishes the bridge. It is in the game from today's update. Thanks, skyler\\_77.",
    );
    assert.equal(m.embeds[0]!.color, 0x5be08e);
    assert.ok(mentionsNobody(msg));
  });

  test('row 5: fixed with no note and no name ("not known yet") has no placeholder words', () => {
    const m = readMessage(fixed(CODE));
    const d = m.embeds[0]!.description ?? '';
    assert.ok(d.includes("It is in the game from today's update."), d);
    assert.ok(!/undefined|null|Thanks,/.test(d), d);
  });

  test('row 3: fixed escapes the player name and the note; nothing hostile reaches the title', () => {
    const msg = fixed(CODE, HOSTILE, '**Kev**');
    const m = readMessage(msg);
    assert.equal(m.embeds[0]!.title, `Fixed · ${CODE}`);
    const d = m.embeds[0]!.description ?? '';
    assert.ok(d.includes('\\*\\*grassetto\\*\\*'), d);
    assert.ok(!d.includes('**grassetto**'), d);
    assert.ok(d.includes('\\*\\*Kev\\*\\*'), d);
    assert.ok(mentionsNobody(msg));
  });

  test('design: sameBug with the original fixed reads as the mockup, grey', () => {
    const m = readMessage(sameBug('LUM-482540', CODE, 'fixed'));
    assert.equal(m.embeds[0]!.title, 'Same bug · LUM-482540');
    assert.equal(m.embeds[0]!.description, `This is the same as ${CODE}, which is fixed. Thanks for telling us.`);
    assert.equal(m.embeds[0]!.color, 0x949ba4);
  });

  for (const status of ['looking', 'received', undefined] as const) {
    test(`design: sameBug with the original ${status ?? 'unknown'} does not claim it is fixed`, () => {
      const msg = sameBug('LUM-482540', CODE, status as OriginalStatus);
      assert.equal(readMessage(msg).embeds[0]!.description, `This is the same as ${CODE}. Thanks for telling us.`);
      assert.ok(mentionsNobody(msg));
    });
  }

  test('design: statusReply maps the four public statuses, ephemeral', () => {
    const cases: Array<[string, string]> = [
      ['received', `${CODE}: Received.`],
      ['looking', `${CODE}: We're looking.`],
      ['fixed', `${CODE}: Fixed. It is in the game.`],
      ['checked', `${CODE}: Checked.`],
    ];
    for (const [status, text] of cases) {
      const msg = statusReply(CODE, status as PublicStatus);
      assert.equal(readMessage(msg).content, text);
      assert.ok(isEphemeral(msg), status);
      assert.ok(mentionsNobody(msg), status);
    }
  });

  test('row 7: tryAgain is exactly the agreed text, ephemeral, no mentions', () => {
    const msg = tryAgain();
    assert.equal(readMessage(msg).content, TRY_AGAIN);
    assert.ok(isEphemeral(msg));
    assert.ok(mentionsNobody(msg));
  });

  test('row 6: gameReportPost names the post "Bug report: <title>" and puts the context in a json block', () => {
    const post = gameReportPost(row({
      code: 'LUM-333333',
      source: 'game',
      title: 'Boss stuck on bridge',
      what: 'The boss stopped on the bridge and the wave never ended.',
      game_context: JSON.stringify({ placeId: 1, map: 'Bridge', wave: 12, device: 'phone' }),
    }));
    assert.equal(post.name, 'Bug report: Boss stuck on bridge');
    const m = readMessage(post.message);
    const content = m.content ?? '';
    assert.ok(content.includes('The boss stopped on the bridge and the wave never ended.'), content);
    assert.ok(content.includes('```json'), content);
    assert.match(content, /"wave": 12/);
    assert.match(content, /"map": "Bridge"/);
    assert.ok(content.length <= 2000);
    assert.ok(mentionsNobody(post.message));
  });

  test('row 3 + row 6: a hostile game title and text are escaped; backticks cannot close the block early', () => {
    const post = gameReportPost(row({
      code: 'LUM-333333',
      source: 'game',
      title: HOSTILE,
      what: HOSTILE,
      game_context: JSON.stringify({ errors: ['```\n@everyone **x**', 'ok'] }),
    }));
    // fix round 1, decision 7: post titles do not render markdown, so the name is not escaped (cut to 100).
    assert.equal(post.name, `Bug report: ${HOSTILE}`);
    const content = readMessage(post.message).content ?? '';
    assert.ok(content.includes('\\*\\*grassetto\\*\\*'), content);
    assert.equal(content.split('```').length - 1, 2, 'exactly one opening and one closing fence');
    assert.ok(mentionsNobody(post.message));
  });

  test('design: gameReportPost stays within Discord limits for a long title, text and context', () => {
    const post = gameReportPost(row({
      code: 'LUM-333333',
      source: 'game',
      title: 'T'.repeat(200),
      what: 'W'.repeat(2000),
      game_context: JSON.stringify({ errors: Array.from({ length: 50 }, () => 'e'.repeat(300)) }),
    }));
    assert.ok(post.name.length <= 100, `name ${post.name.length}`);
    const content = readMessage(post.message).content ?? '';
    assert.ok(content.length <= 2000, `content ${content.length}`);
    assert.equal(content.split('```').length - 1, 2, 'the block is still closed after cutting');
  });

  test('design: gameReportPost with no context ("missing") still posts the text', () => {
    const post = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: 'Hi', what: 'Text here', game_context: null }));
    assert.equal(post.name, 'Bug report: Hi');
    assert.ok((readMessage(post.message).content ?? '').includes('Text here'));
  });

  // fix round 1, decision 7: thread names are the first line, control characters removed, cut to 100, not escaped.
  test('fix1-7: a game report title keeps its markdown characters in the post name', () => {
    const post = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: '**Boss** stuck_on `bridge`', what: 'x' }));
    assert.equal(post.name, 'Bug report: **Boss** stuck_on `bridge`');
  });

  test('fix1-7: control characters are removed from the post name', () => {
    const post = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: 'Boss\u0007 st\u0000uck\r\nsecond', what: 'x' }));
    assert.equal(post.name, 'Bug report: Boss stuck');
  });

  test('fix1-7: a title of control characters only falls back to "Bug report"', () => {
    const post = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: '\u0007\u0008', what: 'x' }));
    assert.equal(post.name, 'Bug report');
  });

  test('fix1-7: a name exactly at 100 characters is kept whole; one more is cut to 100', () => {
    // 'Bug report: ' is 12 characters: 88 stars make exactly 100, unescaped.
    const at = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: '*'.repeat(88), what: 'x' }));
    assert.equal(at.name, `Bug report: ${'*'.repeat(88)}`);
    const over = gameReportPost(row({ code: 'LUM-333333', source: 'game', title: '*'.repeat(89), what: 'x' }));
    assert.ok(over.name.length <= 100, `name ${over.name.length}`);
    assert.ok(over.name.startsWith(`Bug report: ${'*'.repeat(80)}`), over.name);
    assert.ok(!over.name.includes('\\'), 'no escape backslash');
  });
});
