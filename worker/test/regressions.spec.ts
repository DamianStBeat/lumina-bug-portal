// Regressions found by the audits of round 1 (audit.md findings 1 and 2) and round 2 (R2-1, R2-2). The round 1
// pre-state: R2 finished the multipart upload but the D1 batch that follows never ran (a transient D1 error), so the
// row still says `uploading` while the whole object sits in R2. Round 2: R2 and D1 disagree the other way (upload
// aborted in R2, row still `uploading`), and the cron racing a player's complete. CONTRACT.md "Public" (complete,
// DELETE), "Privacy" and "Retention".
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
  expectError,
  pattern,
  putPart,
  reportByCode,
  runCron,
  sha256Hex,
} from "./helpers";

type AttachmentCreated = { attachmentId: string; partSize: number; partCount: number };

const SIZE = 1000;

/**
 * An attachment made through the public API with its one part uploaded through the API and recorded in D1, not yet
 * completed anywhere: the state just before the player's `POST complete`.
 */
async function partsUploaded() {
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
  expect(parts.map((p) => p.n), "every part is recorded in D1").toEqual([1]);
  expect(row.status, "D1 says uploading").toBe("uploading");
  const reportId = (await reportByCode(r.code))!.id;
  return { id, token: r.reportToken, key: row.r2_key, uploadId: row.upload_id!, reportId, bytes, parts };
}

/**
 * The same attachment completed in R2 directly with the parts D1 holds, as the worker's complete does before its D1
 * batch: D1 is left exactly as a failed batch leaves it.
 */
async function completedInR2Only() {
  const s = await partsUploaded();
  await env.FILES.resumeMultipartUpload(s.key, s.uploadId).complete(
    s.parts.map((p) => ({ partNumber: p.n, etag: p.etag })),
  );

  // The pre-state the specs rely on, read back from the bindings rather than assumed.
  expect((await attachmentById(s.id))!.status, "D1 still says uploading").toBe("uploading");
  expect(await env.FILES.head(s.key), "R2 holds the finished object").not.toBeNull();
  return s;
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

// Regressions found by the audit of round 2 (audit.md R2-1, R2-2).
describe("audit round 2", () => {
  it("audit-2: complete after R2 aborted the upload answers 409 not_uploading, no complete row, no file_added", async () => {
    const s = await partsUploaded();
    // DELETE in flight or the cron aborted it in R2; its D1 write has not landed yet.
    await env.FILES.resumeMultipartUpload(s.key, s.uploadId).abort();
    expect((await attachmentById(s.id))!.status, "D1 still says uploading").toBe("uploading");
    expect(await env.FILES.head(s.key), "R2 holds no object").toBeNull();

    await expectError(await completeUpload(s.id, s.token), 409, "not_uploading");
    expect((await attachmentById(s.id))!.status, "no complete row over a missing object").not.toBe("complete");
    expect(await eventTypesOf(s.reportId), "no file_added for a file that does not exist").not.toContain("file_added");
  });

  // R2-1: the player's complete lands while the cron retires the same 8-day-old upload. Miniflare runs one request
  // at a time, so the interleaving is forced: a wrapped FILES binding given to the cron runs the player's complete
  // (through the real worker, real env) at one chosen point of the cron's R2 calls on that key.
  type Point = "before abort" | "after abort" | "before head" | "before delete";
  const POINTS: Point[] = ["before abort", "after abort", "before head", "before delete"];
  const PRESTATES = {
    "parts uploaded": partsUploaded,
    "R2 already completed": completedInR2Only,
  } as const;
  const cases = (Object.keys(PRESTATES) as (keyof typeof PRESTATES)[]).flatMap((pre) =>
    POINTS.map((point) => [pre, point] as const),
  );

  /** env.FILES, with `fire(point)` awaited at each point of the R2 calls the caller makes on `key`. */
  function hookedFiles(key: string, fire: (point: Point) => Promise<void>): R2Bucket {
    const real = env.FILES;
    const bind = (target: object, prop: PropertyKey) => {
      const value = (target as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    };
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "resumeMultipartUpload")
          return (k: string, uploadId: string) => {
            const upload = target.resumeMultipartUpload(k, uploadId);
            if (k !== key) return upload;
            return new Proxy(upload, {
              get(u, p) {
                if (p !== "abort") return bind(u, p);
                return async () => {
                  await fire("before abort");
                  await u.abort();
                  await fire("after abort");
                };
              },
            });
          };
        if (prop === "head")
          return async (k: string) => {
            if (k === key) await fire("before head");
            return target.head(k);
          };
        if (prop === "delete")
          return async (keys: string | string[]) => {
            if ([keys].flat().includes(key)) await fire("before delete");
            return target.delete(keys);
          };
        return bind(target, prop);
      },
    });
  }

  it.each(cases)(
    "audit-2: cron on an 8-day upload (%s) with the player's complete %s never leaves a complete row without its object",
    async (pre, point) => {
      const s = await PRESTATES[pre]();
      await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").bind(Date.now() - 8 * DAY, s.id).run();

      let answer: { status: number; body: unknown } | undefined;
      const fired: Point[] = [];
      const files = hookedFiles(s.key, async (at) => {
        fired.push(at);
        if (at !== point || answer) return;
        const res = await completeUpload(s.id, s.token);
        answer = { status: res.status, body: await res.json() };
      });

      await runCron({ FILES: files });

      // A stale upload is always aborted in R2, so the abort points must have been reached; the others depend on
      // the order the worker chooses and are checked only when reached.
      if (point === "before abort" || point === "after abort") expect(fired, "the cron aborted the upload").toContain(point);
      const status = (await attachmentById(s.id))!.status;
      const object = (await env.FILES.head(s.key)) !== null;
      const events = await eventTypesOf(s.reportId);
      const state = { answer: answer?.status, status, object, file_added: events.includes("file_added") };
      if (status === "complete") expect(state, "a complete row keeps its object").toMatchObject({ object: true });
      if (answer?.status === 200) expect(state, "a player answered ok keeps a complete row and its object").toMatchObject({ status: "complete", object: true });
      if (events.includes("file_added")) expect(state, "a file_added event points at an existing object").toMatchObject({ object: true });
    },
  );
});
