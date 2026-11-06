// Copies a Discord post's videos and pictures into the report's archive (CONTRACT.md "Limits": video/* or image/*,
// at most 3, each <= 2 GiB). Anything else is never downloaded. One bad file never stops the others or the report.
import type { Logger } from './config.ts';
import { type CopyLimiter, copyLimiter } from './limiter.ts';
import { errorTag, type FetchLike, type PortalApi } from './portal.ts';

/** The fields of a discord.js Attachment this module reads (a real Attachment fits). */
export type MediaAttachment = { name: string; size: number; contentType: string | null; url: string };

export type CopyResult = { copied: number; skipped: number; failed: number };

const MAX_FILES = 3;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const FILENAME_MAX = 120;
// Covers the whole streamed copy (download and upload run together), so it is sized for a 2 GiB video.
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** The declared media type without parameters, or undefined when it is not a video or picture. */
function mediaType(contentType: string | null): string | undefined {
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return mime.startsWith('video/') || mime.startsWith('image/') ? mime : undefined;
}

/** No path separators or control characters; long names keep their extension. */
export function sanitiseFilename(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  if (!clean) return 'file';
  if (clean.length <= FILENAME_MAX) return clean;
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? '';
  return clean.slice(0, FILENAME_MAX - ext.length) + ext;
}

export async function copyAttachments(
  api: PortalApi,
  code: string,
  reportToken: string,
  attachments: Iterable<MediaAttachment>,
  fetchImpl: FetchLike,
  log?: Logger,
  copies: CopyLimiter = copyLimiter,
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, failed: 0 };
  // Chosen before the queue: a post with nothing to copy never waits for a slot.
  const planned: { a: MediaAttachment; mime: string }[] = [];
  for (const a of attachments) {
    const mime = mediaType(a.contentType);
    if (mime === undefined || a.size > MAX_BYTES || planned.length >= MAX_FILES) result.skipped += 1;
    else planned.push({ a, mime });
  }
  if (planned.length === 0) return result;
  try {
    // One slot per post, held for its files one after the other (decision 17: the cap counts copy runs).
    await copies.run((signal) => copyPlanned(api, code, reportToken, planned, fetchImpl, signal, result, log));
  } catch (err) {
    // Only a copy that never started gets here (the limiter is draining at shutdown): every file failure inside
    // copyPlanned is caught there.
    result.failed += planned.length - result.copied - result.failed;
    log?.warn('file copy not started', { code, error: errorTag(err) });
  }
  return result;
}

async function copyPlanned(
  api: PortalApi,
  code: string,
  reportToken: string,
  planned: { a: MediaAttachment; mime: string }[],
  fetchImpl: FetchLike,
  stop: AbortSignal,
  result: CopyResult,
  log?: Logger,
): Promise<void> {
  for (const { a, mime } of planned) {
    let res: Response | undefined;
    try {
      // The shutdown abort (decision 22) errors the download stream, so the upload takes its failure path and the
      // half-made attachment is deleted.
      const signal = AbortSignal.any([stop, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
      res = await fetchImpl(a.url, { signal });
      if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
      if (!(a.size > 0)) throw new Error('download size');
      // Streamed part by part: the whole file is never in memory. The size Discord declared is the plan sent to
      // the worker; a download that carries a different number of bytes aborts the upload.
      await api.uploadAttachment(code, reportToken, {
        filename: sanitiseFilename(a.name),
        mime,
        size: a.size,
        body: res.body,
      });
      result.copied += 1;
    } catch (err) {
      result.failed += 1;
      // The count alone cannot tell a CDN refusal from a worker size_mismatch; the tag can, and carries no secret.
      log?.warn('file copy failed', { code, error: errorTag(err) });
    } finally {
      // A body never read (the create failed) would hold its connection open.
      if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
    }
  }
}
