// design.md "portal.ts": PortalApi against a real HTTP server that plays the worker. Failure is a PortalError
// with a code, never a raw fetch error, so every handler can tell "worker down" (row 7) from a refusal.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, deadBase, FakeWorker, PART_SIZE, REPORT_TOKEN } from './fakes/worker.ts';
import { patternBytes } from './fakes/cdn.ts';

let worker: FakeWorker;

before(async () => {
  worker = await FakeWorker.start();
});
after(async () => {
  await worker.stop();
});
beforeEach(() => {
  worker.requests.length = 0;
  worker.mode = 'ok';
  worker.override = undefined;
  worker.reports.clear();
  worker.events.length = 0;
});

function api(timeoutMs = 2000): PortalApi {
  return new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs });
}

async function portalError(p: Promise<unknown>): Promise<PortalError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PortalError, `expected PortalError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to reject');
}

describe('PortalApi', () => {
  test('design: createDiscordReport posts source discord with the bearer key and returns code and token', async () => {
    const res = await api().createDiscordReport({
      discordUserId: '123',
      discordName: 'skyler_77',
      threadId: '456',
      what: 'The boss stopped on the bridge.',
      title: 'Boss stuck',
      where: 'match',
    });
    assert.deepEqual(res, { code: 'LUM-482193', reportToken: REPORT_TOKEN });
    const [req] = worker.find('POST', '/agent/reports');
    assert.ok(req);
    assert.equal(req.headers['authorization'], `Bearer ${AGENT_KEY}`);
    const body = req.json as Record<string, unknown>;
    assert.equal(body['source'], 'discord');
    assert.equal(body['discordUserId'], '123');
    assert.equal(body['discordName'], 'skyler_77');
    assert.equal(body['threadId'], '456');
    assert.equal(body['what'], 'The boss stopped on the bridge.');
    assert.equal(body['title'], 'Boss stuck');
    assert.equal(body['where'], 'match');
  });

  test('design: linkThread posts {threadId} to /agent/reports/{code}/discord', async () => {
    await api().linkThread('LUM-482193', '777');
    const [req] = worker.find('POST', '/agent/reports/LUM-482193/discord');
    assert.ok(req);
    assert.equal(req.headers['authorization'], `Bearer ${AGENT_KEY}`);
    assert.deepEqual(req.json, { threadId: '777' });
  });

  test('design: getReport returns the row', async () => {
    worker.reports.set('LUM-111111', { code: 'LUM-111111', status: 'fixed', discord_thread_id: '9' });
    const row = await api().getReport('LUM-111111');
    assert.equal((row as Record<string, unknown>)['status'], 'fixed');
    assert.equal((row as Record<string, unknown>)['discord_thread_id'], '9');
  });

  test('design: getEvents sends after and limit, and normalises data (string, object, absent, broken)', async () => {
    worker.events.push(
      { seq: 3, code: 'LUM-000003', at: 1, type: 'status_changed', data: '{"from":"looking","to":"fixed","note":"n"}' },
      { seq: 4, code: 'LUM-000004', at: 2, type: 'status_changed', data: { from: 'received', to: 'looking' } },
      { seq: 5, code: 'LUM-000005', at: 3, type: 'created', data: null },
      { seq: 6, code: 'LUM-000006', at: 4, type: 'created', data: '{not json' },
    );
    const res = await api().getEvents(2);
    const [req] = worker.find('GET', '/agent/events');
    assert.ok(req);
    assert.equal(req.query.get('after'), '2');
    assert.equal(req.query.get('limit'), '50');
    assert.equal(res.last, 6);
    assert.deepEqual(
      res.events.map((e: { seq: number }) => e.seq),
      [3, 4, 5, 6],
    );
    assert.deepEqual(res.events[0]!.data, { from: 'looking', to: 'fixed', note: 'n' });
    assert.deepEqual(res.events[1]!.data, { from: 'received', to: 'looking' });
    assert.deepEqual(res.events[2]!.data, {});
    assert.deepEqual(res.events[3]!.data, {});
  });

  test('design: uploadAttachment runs create, every part in slices of partSize, then complete', async () => {
    const size = PART_SIZE + 1234;
    const body = patternBytes(size);
    await api().uploadAttachment('LUM-482193', REPORT_TOKEN, { filename: 'boss.mp4', mime: 'video/mp4', size, body });
    const [create] = worker.find('POST', '/reports/LUM-482193/attachments');
    assert.ok(create);
    assert.equal(create.headers['x-report-token'], REPORT_TOKEN);
    assert.deepEqual(create.json, { filename: 'boss.mp4', size, mime: 'video/mp4' });
    const parts = worker.find('PUT', /^\/attachments\/att-\d+\/parts\/\d+$/);
    assert.deepEqual(
      parts.map((p) => p.path.split('/').pop()),
      ['1', '2'],
    );
    assert.equal(parts[0]!.body.length, PART_SIZE);
    assert.equal(parts[1]!.body.length, 1234);
    assert.ok(Buffer.from(body.subarray(PART_SIZE)).equals(parts[1]!.body), 'second part carries the tail bytes');
    assert.ok(parts.every((p) => p.headers['x-report-token'] === REPORT_TOKEN));
    const complete = worker.find('POST', /^\/attachments\/att-\d+\/complete$/);
    assert.equal(complete.length, 1);
    assert.ok(worker.requests.indexOf(complete[0]!) > worker.requests.indexOf(parts[1]!), 'complete comes last');
  });

  test('design: a failed part aborts the upload (DELETE) and throws', async () => {
    worker.override = (r) => (r.method === 'PUT' ? { status: 500, body: { error: 'internal' } } : undefined);
    const err = await portalError(
      api().uploadAttachment('LUM-482193', REPORT_TOKEN, {
        filename: 'a.png',
        mime: 'image/png',
        size: 10,
        body: patternBytes(10),
      }),
    );
    assert.equal(err.status, 500);
    assert.equal(worker.find('DELETE', /^\/attachments\/att-\d+$/).length, 1);
    assert.equal(worker.find('POST', /\/complete$/).length, 0);
  });

  test('row 7: worker unreachable (connection refused) -> PortalError code network', async () => {
    const dead = new PortalApi({ base: await deadBase(), agentKey: AGENT_KEY, timeoutMs: 2000 });
    const err = await portalError(dead.getEvents(0));
    assert.equal(err.code, 'network');
  });

  test('row 7: worker hangs -> PortalError code timeout within timeoutMs', async () => {
    worker.mode = 'hang';
    const started = Date.now();
    const err = await portalError(api(200).getReport('LUM-111111'));
    assert.equal(err.code, 'timeout');
    assert.ok(Date.now() - started < 3000, 'the timeout fired, not a default one');
  });

  test('row 7: worker drops the connection -> PortalError code network', async () => {
    worker.mode = 'close';
    const err = await portalError(api().linkThread('LUM-111111', '1'));
    assert.equal(err.code, 'network');
  });

  test('design: non-2xx carries status and the worker error field', async () => {
    worker.override = () => ({ status: 429, body: { error: 'rate_limited' } });
    const err = await portalError(
      api().createDiscordReport({ discordUserId: '1', discordName: 'a', what: 'x' }),
    );
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limited');
  });

  test('design: a 2xx body that is not the expected JSON -> bad_response', async () => {
    worker.override = (r) => (r.path === '/agent/reports' ? { status: 201, raw: '<html>gateway</html>' } : undefined);
    const err = await portalError(api().createDiscordReport({ discordUserId: '1', discordName: 'a', what: 'x' }));
    assert.equal(err.code, 'bad_response');
  });

  test('design: a 2xx JSON without the code is a bad_response, not a report with code undefined', async () => {
    worker.override = (r) => (r.path === '/agent/reports' ? { status: 201, body: { ok: true } } : undefined);
    const err = await portalError(api().createDiscordReport({ discordUserId: '1', discordName: 'a', what: 'x' }));
    assert.equal(err.code, 'bad_response');
  });
});
