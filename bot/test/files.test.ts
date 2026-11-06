// design.md "files.ts": only video/* and image/* are copied (row 4: an .exe is not), at most 3, each <= 2 GiB,
// downloaded through fetchImpl (the Discord CDN, faked) and uploaded with the CONTRACT multipart flow.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyAttachments } from '../src/files.ts';
import { PortalApi } from '../src/portal.ts';
import { AGENT_KEY, FakeWorker, REPORT_TOKEN } from './fakes/worker.ts';
import { fakeCdn, patternBytes } from './fakes/cdn.ts';
import { cdnUrl, makeAttachment, type RawAttachment } from './fakes/discord.ts';

const CODE = 'LUM-482193';
const GiB2 = 2 * 1024 * 1024 * 1024;

let worker: FakeWorker;
let api: PortalApi;

before(async () => {
  worker = await FakeWorker.start();
  api = new PortalApi({ base: worker.base, agentKey: AGENT_KEY, timeoutMs: 2000 });
});
after(async () => {
  await worker.stop();
});
beforeEach(() => {
  worker.requests.length = 0;
  worker.mode = 'ok';
  worker.override = undefined;
});

function att(id: string, name: string, size: number, contentType?: string): RawAttachment {
  return contentType === undefined ? { id, name, size } : { id, name, size, contentType };
}

function creates() {
  return worker.find('POST', `/reports/${CODE}/attachments`);
}

describe('copyAttachments', () => {
  test('row 4: an .exe is skipped and not downloaded; the image beside it is copied byte for byte', async () => {
    const exe = att('1', 'free-robux.exe', 4096, 'application/x-msdownload');
    const png = att('2', 'shot.png', 5000, 'image/png');
    const pngBytes = patternBytes(5000, 3);
    const cdn = fakeCdn({ [cdnUrl(exe)]: patternBytes(4096), [cdnUrl(png)]: pngBytes });

    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(exe), makeAttachment(png)], cdn.fetchImpl);

    assert.deepEqual(res, { copied: 1, skipped: 1, failed: 0 });
    assert.deepEqual(cdn.calls, [cdnUrl(png)], 'the .exe is never downloaded');
    assert.equal(creates().length, 1);
    assert.deepEqual(creates()[0]!.json, { filename: 'shot.png', size: 5000, mime: 'image/png' });
    const parts = worker.find('PUT', /\/parts\/1$/);
    assert.equal(parts.length, 1);
    assert.ok(Buffer.from(pngBytes).equals(parts[0]!.body));
    assert.equal(worker.find('POST', /\/complete$/).length, 1);
  });

  test('row 4: an attachment with no content type ("unknown", not "allowed") is skipped', async () => {
    const unknown = att('3', 'clip', 100);
    const cdn = fakeCdn({ [cdnUrl(unknown)]: patternBytes(100) });
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(unknown)], cdn.fetchImpl);
    assert.deepEqual(res, { copied: 0, skipped: 1, failed: 0 });
    assert.equal(cdn.calls.length, 0);
    assert.equal(creates().length, 0);
  });

  test('design: a video is copied with its declared mime', async () => {
    const mp4 = att('4', 'boss-bridge.mp4', 3000, 'video/mp4');
    const cdn = fakeCdn({ [cdnUrl(mp4)]: patternBytes(3000) });
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(mp4)], cdn.fetchImpl);
    assert.deepEqual(res, { copied: 1, skipped: 0, failed: 0 });
    assert.equal((creates()[0]!.json as { mime: string }).mime, 'video/mp4');
  });

  test('design: at most 3 files per report (a 4th and 5th image are not copied)', async () => {
    const list = [1, 2, 3, 4, 5].map((n) => att(String(10 + n), `p${n}.png`, 10, 'image/png'));
    const cdn = fakeCdn(Object.fromEntries(list.map((a) => [cdnUrl(a), patternBytes(10)])));
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, list.map(makeAttachment), cdn.fetchImpl);
    assert.equal(res.copied, 3);
    assert.equal(cdn.calls.length, 3);
    assert.equal(creates().length, 3);
  });

  test('design: a file over 2 GiB is skipped without downloading; exactly 2 GiB is attempted', async () => {
    const over = att('20', 'huge.mp4', GiB2 + 1, 'video/mp4');
    const edge = att('21', 'edge.mp4', GiB2, 'video/mp4');
    // The edge file's CDN link answers 404, so "attempted" is visible without moving 2 GiB through memory.
    const cdn = fakeCdn({}, new Set([cdnUrl(edge)]));
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(over), makeAttachment(edge)], cdn.fetchImpl);
    assert.ok(!cdn.calls.includes(cdnUrl(over)), 'over the limit: not downloaded');
    assert.ok(cdn.calls.includes(cdnUrl(edge)), 'at the limit: downloaded');
    assert.equal(res.copied, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.failed, 1);
  });

  test('design: one failed download does not stop the others', async () => {
    const gone = att('30', 'gone.png', 10, 'image/png');
    const ok = att('31', 'ok.png', 10, 'image/png');
    const cdn = fakeCdn({ [cdnUrl(ok)]: patternBytes(10) }, new Set([cdnUrl(gone)]));
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(gone), makeAttachment(ok)], cdn.fetchImpl);
    assert.deepEqual(res, { copied: 1, skipped: 0, failed: 1 });
    assert.equal(creates().length, 1);
  });

  test('design: one failed upload does not stop the others', async () => {
    const a = att('40', 'a.png', 10, 'image/png');
    const b = att('41', 'b.png', 10, 'image/png');
    let first = true;
    worker.override = (r) => {
      if (r.method === 'POST' && r.path.endsWith('/attachments') && first) {
        first = false;
        return { status: 500, body: { error: 'internal' } };
      }
      return undefined;
    };
    const cdn = fakeCdn({ [cdnUrl(a)]: patternBytes(10), [cdnUrl(b)]: patternBytes(10) });
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(a), makeAttachment(b)], cdn.fetchImpl);
    assert.deepEqual(res, { copied: 1, skipped: 0, failed: 1 });
  });

  test('design: the filename reaching the worker has no path separators or control chars, <= 120 chars', async () => {
    const evil = att('50', `..\\../etc/pa\u0001ss\u0007wd${'x'.repeat(200)}.png`, 10, 'image/png');
    const cdn = fakeCdn({ [cdnUrl(evil)]: patternBytes(10) });
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [makeAttachment(evil)], cdn.fetchImpl);
    assert.equal(res.copied, 1);
    const filename = (creates()[0]!.json as { filename: string }).filename;
    assert.ok(filename.length > 0 && filename.length <= 120, `length ${filename.length}`);
    assert.ok(!/[\\/]/.test(filename), filename);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(filename), JSON.stringify(filename));
  });

  test('design: an empty list copies nothing and calls nothing', async () => {
    const cdn = fakeCdn({});
    const res = await copyAttachments(api, CODE, REPORT_TOKEN, [], cdn.fetchImpl);
    assert.deepEqual(res, { copied: 0, skipped: 0, failed: 0 });
    assert.equal(worker.requests.length, 0);
  });
});
