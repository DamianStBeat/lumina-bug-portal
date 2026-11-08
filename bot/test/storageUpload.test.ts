// Slice 7, the bot side of CONTRACT.md "Supabase deployment": each part goes through POST .../upload-url, then a PUT of
// the raw bytes to the returned URL, which is another origin (fakes/worker.ts FakeStorage) and must get no key at all.
//
// Run by filter: `cd bot && node --test test/storageUpload.test.ts`.
//
// Mutations (file|old|new|label). The production code does not exist yet: `old` describes the line to mutate and the
// auditor fills in its text.
// bot/src/portal.ts|PUT goes to the url the function returned|PUT to the part's API path|s7 row 1 own signed URL
// bot/src/portal.ts|the storage PUT carries no x-report-token and no authorization|send the report token as on every other call|s7 row 1 key never reaches storage
// bot/src/portal.ts|Content-Type application/octet-stream on the storage PUT|send the file's mime|s7 bot content type
// bot/src/portal.ts|POST .../upload-url with the report token|with the bearer agent key|s7 row 1 asked with the report token
// bot/src/portal.ts|a refused URL is asked again once (status 400/401/403)|no second attempt|s7 bot expired URL asked again
// bot/src/portal.ts|the attempt counter is per part|one attempt for the whole file|s7 bot budget is per part
// bot/src/portal.ts|the second attempt uses the fresh url|PUT again to the first url|s7 bot fresh URL
// bot/src/portal.ts|at most one new URL per part|retry while refused|s7 bot asked again only once
// bot/src/portal.ts|only a refusal is asked again|ask again on 5xx too|s7 bot server error is not a refusal
// bot/src/portal.ts|upload-url answer checked for a string url|use the field unchecked|s7 bot bad upload-url answer
// bot/src/portal.ts|PortalError carries the status only|put the signed url in the message|s7 bot secret-free errors
// bot/src/portal.ts|any failure after the create aborts with DELETE|skip the DELETE for storage failures|s7 bot abort
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { errorTag, PortalApi, PortalError } from '../src/portal.ts';
import { AGENT_KEY, FakeWorker, PART_SIZE, REPORT_TOKEN } from './fakes/worker.ts';
import { patternBytes } from './fakes/cdn.ts';

const CODE = 'LUM-482193';

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
  worker.storage.reset();
});

function api(timeoutMs = 2000): PortalApi {
  return new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs });
}

function upload(size: number, body: Uint8Array | AsyncIterable<Uint8Array> = patternBytes(size), timeoutMs = 2000) {
  return api(timeoutMs).uploadAttachment(CODE, REPORT_TOKEN, { filename: 'boss.mp4', mime: 'video/mp4', size, body });
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

function urlAsks(n?: number) {
  const asks = worker.find('POST', /^\/attachments\/att-\d+\/parts\/\d+\/upload-url$/);
  return n === undefined ? asks : asks.filter((r) => r.path.split('/').at(-2) === String(n));
}

function attachmentId(): string {
  const id = worker.find('POST', /^\/attachments\/att-\d+\/parts\/\d+\/upload-url$/)[0]?.path.split('/')[2];
  assert.ok(id, 'the upload asked for at least one URL');
  return id;
}

const SIZE_3_PARTS = 2 * PART_SIZE + 5;

function assertAborted(): void {
  assert.equal(worker.find('DELETE', /^\/attachments\/att-\d+$/).length, 1, 'the upload was aborted');
  assert.equal(worker.find('POST', /\/complete$/).length, 0, 'never completed');
}

describe('slice 7: upload through signed URLs', () => {
  test('s7 row 1: each part asks for its own URL and the bucket ends up with the file, in order', async () => {
    const body = patternBytes(SIZE_3_PARTS);
    await upload(SIZE_3_PARTS, body);

    assert.deepEqual(
      urlAsks().map((r) => Number(r.path.split('/').at(-2))),
      [1, 2, 3],
      'one upload-url per part, ascending',
    );
    const puts = worker.storage.puts();
    assert.deepEqual(
      puts.map((p) => p.part),
      [1, 2, 3],
      'one PUT per part, each on the URL signed for it',
    );
    assert.equal(new Set(puts.map((p) => p.token)).size, 3, 'three different URLs, one per part');
    assert.deepEqual(
      puts.map((p) => p.body.length),
      [PART_SIZE, PART_SIZE, 5],
    );
    assert.ok(worker.storage.joined(attachmentId(), 3).equals(Buffer.from(body)), 'the bucket holds the exact bytes');
    assert.equal(worker.find('POST', /\/complete$/).length, 1, 'completed once');
    assert.equal(worker.find('DELETE', /^\/attachments\/att-\d+$/).length, 0, 'nothing aborted');
    assert.equal(worker.find('PUT', /\/parts\/\d+$/).length, 0, 'no byte goes through the function');
  });

  test('s7 row 1: upload-url is asked with the report token, not with the agent key', async () => {
    await upload(10);
    const [ask] = urlAsks();
    assert.ok(ask);
    assert.equal(ask.headers['x-report-token'], REPORT_TOKEN);
    assert.equal(ask.headers['authorization'], undefined, 'the agent key is not for a report route');
  });

  test('s7 row 1: the key does not reach the storage', async () => {
    await upload(SIZE_3_PARTS);
    const seen = worker.storage.requests;
    assert.equal(seen.length, 3, 'the bucket was reached');
    for (const r of seen) {
      assert.equal(r.headers['authorization'], undefined, 'no bearer on a signed URL');
      assert.equal(r.headers['x-report-token'], undefined, 'no report token on a signed URL');
      assert.equal(r.headers['apikey'], undefined, 'no project key on a signed URL');
      const everyValue = `${Object.values(r.headers).join(' ')} ${r.query.toString()}`;
      assert.ok(!everyValue.includes(AGENT_KEY), 'the agent key is nowhere in the request');
      assert.ok(!everyValue.includes(REPORT_TOKEN), 'the report token is nowhere in the request');
    }
  });

  test('s7 bot: a part is sent as application/octet-stream whatever the file is', async () => {
    await upload(10);
    const [put] = worker.storage.puts();
    assert.ok(put);
    assert.equal(put.headers['content-type'], 'application/octet-stream');
  });

  test('s7 row 1 edge: a file of exactly one part size asks for one URL only', async () => {
    await upload(PART_SIZE);
    assert.equal(urlAsks().length, 1);
    assert.deepEqual(
      worker.storage.puts().map((p) => p.body.length),
      [PART_SIZE],
    );
    assert.equal(worker.find('POST', /\/complete$/).length, 1);
  });

  test('s7 row 1 edge: one byte more asks for a second URL', async () => {
    await upload(PART_SIZE + 1);
    assert.equal(urlAsks().length, 2);
    assert.deepEqual(
      worker.storage.puts().map((p) => p.body.length),
      [PART_SIZE, 1],
    );
  });

  test('s7 row 1: bytes arriving as a stream reach the bucket the same way', async () => {
    const body = patternBytes(SIZE_3_PARTS);
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let off = 0; off < body.byteLength; off += 7 * 1024 * 1024) yield body.subarray(off, off + 7 * 1024 * 1024);
    }
    await upload(SIZE_3_PARTS, chunks());
    assert.ok(worker.storage.joined(attachmentId(), 3).equals(Buffer.from(body)));
  });

  test('s7 bot: an expired URL (403) is asked again once and the same bytes go to the new one', async () => {
    const body = patternBytes(SIZE_3_PARTS);
    worker.storage.killNextUrls(2);
    await upload(SIZE_3_PARTS, body);

    assert.equal(urlAsks(1).length, 1);
    assert.equal(urlAsks(2).length, 2, 'part 2 asked again once');
    assert.equal(urlAsks(3).length, 1);
    const part2 = worker.storage.puts().filter((p) => p.part === 2);
    assert.equal(part2.length, 2, 'the dead URL, then the fresh one');
    assert.notEqual(part2[0]!.token, part2[1]!.token, 'the second try is on a new URL');
    assert.ok(part2[1]!.body.equals(Buffer.from(body.subarray(PART_SIZE, 2 * PART_SIZE))), 'the same bytes are sent again');
    assert.ok(worker.storage.joined(attachmentId(), 3).equals(Buffer.from(body)), 'nothing lost or reordered');
    assert.equal(worker.find('POST', /\/complete$/).length, 1, 'then the upload goes on to its end');
  });

  for (const status of [400, 401, 403]) {
    test(`s7 bot: a refused URL (${status}) is asked again once`, async () => {
      worker.storage.deadStatus = status;
      worker.storage.killNextUrls(1);
      await upload(10);
      assert.equal(urlAsks(1).length, 2);
      assert.equal(worker.find('POST', /\/complete$/).length, 1);
    });
  }

  test('s7 bot: the budget is per URL: two different parts can each be asked again', async () => {
    const body = patternBytes(SIZE_3_PARTS);
    worker.storage.killNextUrls(1);
    worker.storage.killNextUrls(3);
    await upload(SIZE_3_PARTS, body);
    assert.equal(urlAsks(1).length, 2);
    assert.equal(urlAsks(2).length, 1);
    assert.equal(urlAsks(3).length, 2);
    assert.ok(worker.storage.joined(attachmentId(), 3).equals(Buffer.from(body)));
  });

  test('s7 bot: refused twice in a row aborts the upload, without a third URL', async () => {
    worker.storage.killNextUrls(2, 5);
    const err = await portalError(upload(SIZE_3_PARTS));
    assert.equal(err.status, 403);
    assert.equal(urlAsks(2).length, 2, 'asked again once, not more');
    assert.equal(urlAsks(3).length, 0, 'the next part is never started');
    assertAborted();
  });

  test('s7 bot: a storage server error is not a refusal: no new URL, the upload is aborted', async () => {
    worker.storage.override = () => ({ status: 500, body: { error: 'internal' } });
    const err = await portalError(upload(10));
    assert.equal(err.status, 500);
    assert.equal(urlAsks(1).length, 1, 'a 500 says nothing about the URL');
    assertAborted();
  });

  test('s7 bot: the storage drops the connection: a PortalError and the upload is aborted', async () => {
    worker.storage.override = () => 'close';
    const err = await portalError(upload(10));
    assert.equal(err.code, 'network');
    assertAborted();
  });

  test('s7 bot: the storage never answers: the timeout fires and the upload is aborted', async () => {
    worker.storage.override = () => 'hang';
    const started = Date.now();
    const err = await portalError(upload(10, patternBytes(10), 200));
    assert.equal(err.code, 'timeout');
    assert.ok(Date.now() - started < 3000, 'the configured timeout fired');
    assertAborted();
  });

  test('s7 bot: 409 not_uploading from upload-url stops the upload before any PUT', async () => {
    worker.override = (r) => (r.path.endsWith('/upload-url') ? { status: 409, body: { error: 'not_uploading' } } : undefined);
    const err = await portalError(upload(10));
    assert.equal(err.code, 'not_uploading');
    assert.equal(err.status, 409);
    assert.equal(worker.storage.requests.length, 0);
    assertAborted();
  });

  for (const [label, body] of [
    ['no url', { n: 1, expiresIn: 7200 }],
    ['url of the wrong type', { n: 1, url: 42, expiresIn: 7200 }],
    ['not an object', [1, 2]],
  ] as const) {
    test(`s7 bot: an upload-url answer with ${label} is bad_response and nothing is sent`, async () => {
      worker.override = (r) => (r.path.endsWith('/upload-url') ? { status: 200, body } : undefined);
      const err = await portalError(upload(10));
      assert.equal(err.code, 'bad_response');
      assert.equal(worker.storage.requests.length, 0);
      assertAborted();
    });
  }

  test('s7 bot: errors and log tags carry no signed URL and no token', async () => {
    worker.storage.killNextUrls(1, 5);
    const err = await portalError(upload(10));
    const tokens = worker.storage.puts().map((p) => p.token!);
    assert.ok(tokens.length > 0, 'the scenario reached the bucket');
    for (const text of [err.message, errorTag(err)]) {
      for (const token of tokens) assert.ok(!text.includes(token), `no signed token in: ${text}`);
      assert.ok(!text.includes('/storage/v1/'), `no storage URL in: ${text}`);
    }
  });
});
