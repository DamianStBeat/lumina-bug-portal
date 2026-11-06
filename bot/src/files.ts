// Copies a Discord post's videos and pictures into the report's archive (CONTRACT.md "Limits": video/* or image/*,
// at most 3, each <= 2 GiB). Anything else is never downloaded. One bad file never stops the others or the report.
import type { FetchLike, PortalApi } from './portal.ts';

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
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, failed: 0 };
  let attempted = 0;
  for (const a of attachments) {
    const mime = mediaType(a.contentType);
    if (mime === undefined || a.size > MAX_BYTES || attempted >= MAX_FILES) {
      result.skipped += 1;
      continue;
    }
    attempted += 1;
    let res: Response | undefined;
    try {
      res = await fetchImpl(a.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
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
    } catch {
      result.failed += 1;
    } finally {
      // A body never read (the create failed) would hold its connection open.
      if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
    }
  }
  return result;
}
