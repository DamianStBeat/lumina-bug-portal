// Daily retention cron (acceptance row 19). CONTRACT.md "Limits" > Retention.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { attachmentById, DAY, MIB, pattern, reportByCode, runCron, seedAttachment, seedReport } from "./helpers";

async function seedStoredVideo(ageDays: number) {
  const created = Date.now() - ageDays * DAY;
  const r = await seedReport({ created_at: created });
  const a = await seedAttachment(r.id, { created_at: created, status: "complete", completed_at: created, size_bytes: 1000 });
  await env.FILES.put(a.r2_key, pattern(19, 0, 1000));
  return { report: r, attachment: a };
}

async function seedOpenUpload(ageDays: number) {
  const created = Date.now() - ageDays * DAY;
  const r = await seedReport({ created_at: created });
  const key = `spec/upload-${crypto.randomUUID()}`;
  const upload = await env.FILES.createMultipartUpload(key);
  await upload.uploadPart(1, pattern(19, 0, 5 * MIB));
  const a = await seedAttachment(r.id, {
    created_at: created,
    status: "uploading",
    r2_key: key,
    upload_id: upload.uploadId,
    part_size: 16 * MIB,
    part_count: 2,
    size_bytes: 20 * MIB,
  });
  return { report: r, attachment: a };
}

/** True while R2 still accepts parts for this multipart upload. */
async function uploadStillOpen(key: string, uploadId: string): Promise<boolean> {
  try {
    await env.FILES.resumeMultipartUpload(key, uploadId).uploadPart(2, pattern(19, 1, 10));
    return true;
  } catch {
    return false;
  }
}

describe("retention cron", () => {
  it("row 19: 61-day video deleted (row kept, deleted), 8-day upload aborted, 3-day ip_hash nulled", async () => {
    const video = await seedStoredVideo(61);
    const upload = await seedOpenUpload(8);
    const withIp = await seedReport({ created_at: Date.now() - 3 * DAY, ip_hash: "a".repeat(64) });

    await runCron();

    expect(await env.FILES.head(video.attachment.r2_key)).toBeNull();
    const videoRow = await attachmentById(video.attachment.id);
    expect(videoRow, "the attachment row is kept").not.toBeNull();
    expect(videoRow!.status).toBe("deleted");
    expect(await reportByCode(video.report.code), "the report row is kept").not.toBeNull();

    expect((await attachmentById(upload.attachment.id))!.status).toBe("aborted");
    expect(await uploadStillOpen(upload.attachment.r2_key, upload.attachment.upload_id!)).toBe(false);

    expect((await reportByCode(withIp.code))!.ip_hash).toBeNull();
  });

  it("row 19 (edge): a 59-day video, a 6-day upload and a 1-day ip_hash are left alone", async () => {
    const video = await seedStoredVideo(59);
    const upload = await seedOpenUpload(6);
    const withIp = await seedReport({ created_at: Date.now() - 1 * DAY, ip_hash: "b".repeat(64) });

    await runCron();

    expect(await env.FILES.head(video.attachment.r2_key)).not.toBeNull();
    expect((await attachmentById(video.attachment.id))!.status).toBe("complete");
    expect((await attachmentById(upload.attachment.id))!.status).toBe("uploading");
    expect(await uploadStillOpen(upload.attachment.r2_key, upload.attachment.upload_id!)).toBe(true);
    expect((await reportByCode(withIp.code))!.ip_hash).toBe("b".repeat(64));
  });

  it("contract: a report older than 12 months is deleted, a 300-day one is kept", async () => {
    const old = await seedReport({ created_at: Date.now() - 400 * DAY });
    const young = await seedReport({ created_at: Date.now() - 300 * DAY });
    await runCron();
    expect(await reportByCode(old.code)).toBeNull();
    expect(await reportByCode(young.code)).not.toBeNull();
  });
});
