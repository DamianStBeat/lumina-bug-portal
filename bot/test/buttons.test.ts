// design.md "buttons.ts": the "See status" button answers only the player who pressed it.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleButton } from '../src/buttons.ts';
import { PortalApi } from '../src/portal.ts';
import { AGENT_KEY, deadBase, FakeWorker } from './fakes/worker.ts';
import { buttonInteraction, FakeForum, makeUser, mentionsNobody, readMessage } from './fakes/discord.ts';
import { makeConfig, makeLogger, makeTempDir, removeDir, TRY_AGAIN } from './fakes/common.ts';

const CODE = 'LUM-482193';
const PLAYER = makeUser('123456789012345678', 'skyler_77');

let worker: FakeWorker;
let stateDir: string;

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
  worker.reports.clear();
});

type Interaction = Parameters<typeof handleButton>[0];

async function press(customId: string, base = worker.base) {
  const i = buttonInteraction(PLAYER, new FakeForum(), customId);
  const d = { api: new PortalApi({ base, agentKey: AGENT_KEY, timeoutMs: 2000 }), config: makeConfig(base, stateDir), log: makeLogger() };
  await assert.doesNotReject(handleButton(i as unknown as Interaction, d));
  return i;
}

describe('See status button', () => {
  const cases: Array<[string, string]> = [
    ['received', `${CODE}: Received.`],
    ['looking', `${CODE}: We're looking.`],
    ['fixed', `${CODE}: Fixed. It is in the game.`],
    ['not_bug', `${CODE}: Checked.`],
    ['closed', `${CODE}: Checked.`],
  ];
  for (const [status, text] of cases) {
    test(`design: internal status ${status} -> ephemeral "${text}"`, async () => {
      worker.reports.set(CODE, { code: CODE, status, source: 'discord' });
      const i = await press(`status:${CODE}`);
      const final = i.finalAnswer();
      assert.ok(final);
      assert.equal(readMessage(final.options).content, text);
      assert.equal(final.ephemeral, true);
      assert.ok(mentionsNobody(final.options));
      assert.equal(worker.find('GET', `/agent/reports/${CODE}`).length >= 1, true);
    });
  }

  test('design: a duplicate never shows "duplicate"; it shows a public status', async () => {
    worker.reports.set(CODE, { code: CODE, status: 'duplicate', duplicate_of: 'LUM-111111', source: 'discord' });
    worker.reports.set('LUM-111111', { code: 'LUM-111111', status: 'looking', source: 'web' });
    const i = await press(`status:${CODE}`);
    assert.equal(readMessage(i.finalAnswer()!.options).content, `${CODE}: We're looking.`);
  });

  test('row 7: worker down -> ephemeral "Couldn\'t send it. Try again in a minute."', async () => {
    const i = await press(`status:${CODE}`, await deadBase());
    const final = i.finalAnswer();
    assert.ok(final);
    assert.equal(readMessage(final.options).content, TRY_AGAIN);
    assert.equal(final.ephemeral, true);
  });

  for (const bad of ['status:LUM-12345', 'status:LUM-1234567', 'status:../agent/queue', 'status:lum-123456', 'other:LUM-123456']) {
    test(`design: custom id "${bad}" is ignored, nothing reaches the worker`, async () => {
      await press(bad);
      assert.equal(worker.requests.length, 0);
    });
  }

  // fix round 1, decision 6 read a nested `{ report, attachments }` answer like the flat row. Contract slice
  // (tests-commit 1): CONTRACT.md "Agent report shape" now pins the flat row only (the nested one: contract.test.ts k7),
  // so this case feeds the flat row, fixed.
  test('fix1-6: the flat row, fixed, shows the report\'s status', async () => {
    worker.override = (r) =>
      r.method === 'GET' && r.path === `/agent/reports/${CODE}`
        ? { status: 200, body: { code: CODE, status: 'fixed', source: 'discord', attachments: [] } }
        : undefined;
    const i = await press(`status:${CODE}`);
    const final = i.finalAnswer();
    assert.ok(final);
    assert.equal(readMessage(final.options).content, `${CODE}: Fixed. It is in the game.`);
    assert.equal(final.ephemeral, true);
  });

  test('fix1-6: the flat row with an attachments list (the worker\'s own shape) still reads', async () => {
    worker.override = (r) =>
      r.method === 'GET' && r.path === `/agent/reports/${CODE}`
        ? { status: 200, body: { code: CODE, status: 'looking', source: 'discord', attachments: [] } }
        : undefined;
    const i = await press(`status:${CODE}`);
    assert.equal(readMessage(i.finalAnswer()!.options).content, `${CODE}: We're looking.`);
  });

  // fix round 3, decision 20: a row without a string status (or code) is a bad answer, never a guessed status.
  for (const [label, body] of [
    ['a flat row without status', { code: CODE, source: 'discord' }],
    ['a flat row with a numeric status', { code: CODE, status: 3, source: 'discord' }],
    ['a nested report without status', { report: { code: CODE, source: 'discord' }, attachments: [] }],
    ['a nested report without code', { report: { status: 'fixed', source: 'discord' }, attachments: [] }],
  ] as const) {
    test(`fix3-20: ${label} -> "Couldn't send it. Try again in a minute."`, async () => {
      worker.override = (r) => (r.method === 'GET' && r.path === `/agent/reports/${CODE}` ? { status: 200, body } : undefined);
      const i = await press(`status:${CODE}`);
      const final = i.finalAnswer();
      assert.ok(final);
      assert.equal(readMessage(final.options).content, TRY_AGAIN);
      assert.equal(final.ephemeral, true);
    });
  }

  test('fix3-20: a duplicate whose original row has no status shows "looking", not a guess', async () => {
    worker.reports.set(CODE, { code: CODE, status: 'duplicate', duplicate_of: 'LUM-111111', source: 'discord' });
    worker.reports.set('LUM-111111', { code: 'LUM-111111', source: 'web' });
    const i = await press(`status:${CODE}`);
    assert.equal(readMessage(i.finalAnswer()!.options).content, `${CODE}: We're looking.`);
  });
});
