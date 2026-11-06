// Regressions found by the audit of round 1 (audit.md findings 1 and 2). One pre-state for all of them: R2 finished
// the multipart upload but the D1 batch that follows never ran (a transient D1 error), so the row still says
// `uploading` while the whole object sits in R2. CONTRACT.md "Public" (complete, DELETE), "Privacy" and "Retention".
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  attachmentById,
  body,
  call,
  completeUpload,
  createAttachment,
  createReport,
  DAY,
  eventTypesOf,
  pattern,
  putPart,
  reportByCode,
  runCron,
  sha256Hex,
} from "./helpers";

type AttachmentCreated = { attachmentId: string; partSize: number; partCount: number };

const SIZE = 1000;

/**
 * An attachment made through the public API, its one part uploaded through the API, then completed in R2 directly
 * with the parts D1 holds, as the worker's complete does before its D1 batch: D1 is left exactly as a failed batch
 * leaves it.
 */
async function completedInR2Only() {
  const r = await createReport();
  const res = await createAttachment(r.code, r.reportToken, { size: SIZE });
  expect(res.status, "creating an attachment for this spec").toBe(201);
  const { attachmentId: id } = await body<AttachmentCreated>(res);
  const bytes = pattern(41, 0, SIZE);
  expect((await putPart(id, 1, r.reportToken, bytes)).status, "uploading the only part").toBe(200);

  const row = (await attachmentById(id))!;
  const { results: parts } = await env.DB.prepare("SELECT n, etag FROM parts WHERE attachment_id = ? ORDER BY n")
    .bind(id)
    .all<{ n: number; etag: string }>();
  await env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id!).complete(
    parts.map((p) => ({ partNumber: p.n, etag: p.etag })),
  );

  // The pre-state the specs rely on, read back from the bindings rather than assumed.
  expect((await attachmentById(id))!.status, "D1 still says uploading").toBe("uploading");
  expect(await env.FILES.head(row.r2_key), "R2 holds the finished object").not.toBeNull();
  const reportId = (await reportByCode(r.code))!.id;
  return { id, token: r.reportToken, key: row.r2_key, reportId, bytes };
}

describe("audit round 1: R2 completed, D1 still uploading", () => {
  it("audit-1: complete after R2 already completed answers 200 ok, row complete, exactly one file_added", async () => {
    const s = await completedInR2Only();

    const res = await completeUpload(s.id, s.token);
    expect([res.status, await body(res)]).toEqual([200, { ok: true }]);
    expect((await attachmentById(s.id))!.status).toBe("complete");
    expect((await eventTypesOf(s.reportId)).filter((t) => t === "file_added")).toEqual(["file_added"]);

    // A client retrying after a lost answer still gets ok and adds no second event.
    const again = await completeUpload(s.id, s.token);
    expect([again.status, await body(again)]).toEqual([200, { ok: true }]);
    expect((await eventTypesOf(s.reportId)).filter((t) => t === "file_added")).toEqual(["file_added"]);
    const obj = await env.FILES.get(s.key);
    expect(await sha256Hex(await obj!.arrayBuffer()), "the object is the uploaded bytes").toBe(await sha256Hex(s.bytes));
  });

  it("audit-1: DELETE after R2 already completed answers 200 and the R2 object is gone", async () => {
    const s = await completedInR2Only();

    const res = await call(`/attachments/${s.id}`, { method: "DELETE", headers: { "X-Report-Token": s.token } });
    expect(res.status).toBe(200);
    expect(await env.FILES.head(s.key), "no object left behind an aborted row").toBeNull();
    expect(["aborted", "deleted"], "the row no longer holds a live slot").toContain((await attachmentById(s.id))!.status);
  });

  it("audit-1: cron on an 8-day upload that R2 already completed removes the R2 object", async () => {
    const s = await completedInR2Only();
    await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").bind(Date.now() - 8 * DAY, s.id).run();

    await runCron();

    expect(await env.FILES.head(s.key), "a finished video is not kept past retention").toBeNull();
  });

  it("audit-1 (edge): cron on a 6-day upload that R2 already completed leaves object and row alone", async () => {
    const s = await completedInR2Only();
    await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").bind(Date.now() - 6 * DAY, s.id).run();

    await runCron();

    expect(await env.FILES.head(s.key)).not.toBeNull();
    expect((await attachmentById(s.id))!.status).toBe("uploading");
  });
});
