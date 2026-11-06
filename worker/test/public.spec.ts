// Public API (acceptance rows 1-10 and 20). CONTRACT.md "HTTP API" > Public, "Limits", "Statuses".
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  attachmentById,
  attachmentsOf,
  base64urlDecode,
  body,
  call,
  CODE_RE,
  completeUpload,
  createAttachment,
  createReport,
  ERRORS,
  eventTypesOf,
  expectError,
  GIB,
  jsonInit,
  listParts,
  nextIp,
  outbound,
  PART_SIZE,
  partRowsOf,
  pattern,
  postReport,
  putPart,
  reportByCode,
  reportsWithWhatPrefix,
  seedReport,
  sha256Hex,
  sha256OfParts,
  TURNSTILE_FAIL,
  TURNSTILE_PASS,
  uniqueText,
  agentHeaders,
} from "./helpers";

type Created = { code: string; reportToken: string };
type AttachmentCreated = { attachmentId: string; partSize: number; partCount: number };

async function newAttachment(size: number, mime = "video/mp4"): Promise<Created & { reportId: string; id: string }> {
  const r = await createReport();
  const res = await createAttachment(r.code, r.reportToken, { size, mime });
  expect(res.status, "creating an attachment for this spec").toBe(201);
  const a = await body<AttachmentCreated>(res);
  const row = await reportByCode(r.code);
  return { ...r, reportId: row!.id, id: a.attachmentId };
}

describe("POST /reports", () => {
  it("row 1: valid Turnstile and a 30-character text create a web report with code, token and a created event", async () => {
    const what = "The tower button does nothing.";
    expect(what.length).toBe(30);
    const ip = nextIp();
    const res = await postReport({ what, where: "match", device: "phone", lang: "en", turnstileToken: TURNSTILE_PASS }, ip);

    expect(res.status).toBe(201);
    const b = await body<Created>(res);
    expect(b.code).toMatch(CODE_RE);
    expect(b.reportToken).toMatch(/^[A-Za-z0-9_-]{43}=?$/);
    expect(base64urlDecode(b.reportToken).length).toBe(32);
    expect(outbound.turnstileCalls).toBeGreaterThanOrEqual(1);

    const row = await reportByCode(b.code);
    expect(row).not.toBeNull();
    expect(row!.source).toBe("web");
    expect(row!.status).toBe("received");
    expect(row!.what).toBe(what);
    expect(row!.report_token_hash).not.toBe(b.reportToken);
    expect([43, 44, 64]).toContain(row!.report_token_hash.length);
    expect(row!.ip_hash).toBeTruthy();
    expect(row!.ip_hash).not.toContain(ip);
    expect(typeof row!.created_at).toBe("number");
    expect(Math.abs(row!.created_at - Date.now())).toBeLessThan(60_000);
    expect(await eventTypesOf(row!.id)).toEqual(["created"]);
  });

  it.each([
    ["1 character", "x"],
    ["2000 characters", "y".repeat(2000)],
  ])("row 1 (edge): a text of %s is accepted", async (_label, what) => {
    const res = await postReport({ what, turnstileToken: TURNSTILE_PASS });
    expect(res.status).toBe(201);
    const row = await reportByCode((await body<Created>(res)).code);
    expect(row!.what).toBe(what);
  });

  it.each([
    ["empty", ""],
    ["only whitespace and control characters", "   \n\t \u0007  "],
    ["2001 characters", null],
  ])("row 2: a text that is %s is refused with 400 invalid_what and no row", async (_label, given) => {
    const marker = uniqueText("row2");
    const what = given ?? (marker + "z".repeat(2001)).slice(0, 2001);
    if (given === null) expect(what.length).toBe(2001);
    const before = await env.DB.prepare("SELECT count(*) AS n FROM reports").first<{ n: number }>();

    const res = await postReport({ what, turnstileToken: TURNSTILE_PASS });

    await expectError(res, 400, ERRORS.invalidWhat);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM reports").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    expect(await reportsWithWhatPrefix(marker)).toBe(0);
  });

  it("row 2 (missing): a body without `what` is refused with 400 invalid_what", async () => {
    const res = await postReport({ turnstileToken: TURNSTILE_PASS });
    await expectError(res, 400, ERRORS.invalidWhat);
  });

  it("row 3: a Turnstile token the siteverify rejects gives 403 turnstile_failed and no row", async () => {
    const what = uniqueText("row3 rejected");
    const res = await postReport({ what, turnstileToken: TURNSTILE_FAIL });
    await expectError(res, 403, ERRORS.turnstileFailed);
    expect(outbound.turnstileCalls).toBeGreaterThanOrEqual(1);
    expect(await reportsWithWhatPrefix(what)).toBe(0);
  });

  it("row 3 (missing): a request without a Turnstile token is refused and stores nothing", async () => {
    const what = uniqueText("row3 no token");
    const res = await postReport({ what });
    expect([400, 403]).toContain(res.status);
    expect(await reportsWithWhatPrefix(what)).toBe(0);
  });

  it("row 4: the sixth report in the same hour from the same ip gets 429 rate_limited; another ip still passes", async () => {
    const ip = nextIp();
    for (let i = 1; i <= 5; i++) {
      const res = await postReport({ what: uniqueText(`row4 #${i}`), turnstileToken: TURNSTILE_PASS }, ip);
      expect(res.status, `report #${i} of 5`).toBe(201);
    }
    const sixth = uniqueText("row4 #6");
    await expectError(await postReport({ what: sixth, turnstileToken: TURNSTILE_PASS }, ip), 429, ERRORS.rateLimited);
    expect(await reportsWithWhatPrefix(sixth)).toBe(0);

    const other = await postReport({ what: uniqueText("row4 other ip"), turnstileToken: TURNSTILE_PASS }, nextIp());
    expect(other.status).toBe(201);
  });
});

describe("attachments and multipart upload", () => {
  it("row 5: a declared 40 MiB video uploaded as 16/16/8 MiB parts lands in R2 byte for byte, complete, file_added", async () => {
    const sizes = [PART_SIZE, PART_SIZE, 8 * 1024 * 1024];
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBe(41_943_040);
    const r = await createReport();

    const res = await createAttachment(r.code, r.reportToken, { filename: "bug.mp4", size: total, mime: "video/mp4" });
    expect(res.status).toBe(201);
    const a = await body<AttachmentCreated>(res);
    expect(typeof a.attachmentId).toBe("string");
    expect(a.partSize).toBe(16_777_216);
    expect(a.partCount).toBe(3);

    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let n = 1; n <= 3; n++) {
      const bytes = pattern(5, offset, sizes[n - 1]!);
      offset += bytes.length;
      parts.push(bytes);
      const put = await putPart(a.attachmentId, n, r.reportToken, bytes);
      expect(put.status, `part ${n}`).toBe(200);
      const p = await body<{ n: number; etag: string }>(put);
      expect(p.n).toBe(n);
      expect(typeof p.etag).toBe("string");
      expect(p.etag.length).toBeGreaterThan(0);
    }

    const done = await completeUpload(a.attachmentId, r.reportToken);
    expect(done.status).toBe(200);
    expect(await body(done)).toEqual({ ok: true });

    const row = await attachmentById(a.attachmentId);
    expect(row!.status).toBe("complete");
    expect(row!.size_bytes).toBe(total);
    expect(row!.kind).toBe("video");
    expect(typeof row!.completed_at).toBe("number");
    const obj = await env.FILES.get(row!.r2_key);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(total);
    expect(await sha256Hex(await obj!.arrayBuffer())).toBe(await sha256OfParts(parts));
    expect(await eventTypesOf(row!.report_id)).toContain("file_added");
  });

  it.each([
    [1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [2 * GIB, 128],
  ])("row 5 (edge): size %i bytes is split into %i parts of 16 MiB", async (size, count) => {
    const r = await createReport();
    const res = await createAttachment(r.code, r.reportToken, { size });
    expect(res.status).toBe(201);
    const a = await body<AttachmentCreated>(res);
    expect(a.partSize).toBe(PART_SIZE);
    expect(a.partCount).toBe(count);
  });

  it("row 6: part 2 sent twice is listed once, the second copy wins, complete succeeds", async () => {
    const sizes = [PART_SIZE, PART_SIZE, 1000];
    const total = sizes.reduce((a, b) => a + b, 0);
    const att = await newAttachment(total);
    const right = [pattern(6, 0, sizes[0]!), pattern(6, PART_SIZE, sizes[1]!), pattern(6, 2 * PART_SIZE, sizes[2]!)];

    expect((await putPart(att.id, 1, att.reportToken, right[0]!)).status).toBe(200);
    expect((await putPart(att.id, 2, att.reportToken, pattern(99, 0, PART_SIZE))).status).toBe(200);
    expect((await putPart(att.id, 3, att.reportToken, right[2]!)).status).toBe(200);
    expect((await putPart(att.id, 2, att.reportToken, right[1]!)).status).toBe(200);

    const list = await listParts(att.id, att.reportToken);
    expect(list.status).toBe(200);
    const { uploaded } = await body<{ uploaded: { n: number; size: number }[] }>(list);
    expect([...uploaded].sort((x, y) => x.n - y.n)).toEqual([
      { n: 1, size: PART_SIZE },
      { n: 2, size: PART_SIZE },
      { n: 3, size: 1000 },
    ]);

    const done = await completeUpload(att.id, att.reportToken);
    expect(done.status).toBe(200);
    const row = await attachmentById(att.id);
    expect(row!.status).toBe("complete");
    const obj = await env.FILES.get(row!.r2_key);
    expect(await sha256Hex(await obj!.arrayBuffer())).toBe(await sha256OfParts(right));
  });

  it("row 6 (not yet): before any part, the resume list is empty", async () => {
    const att = await newAttachment(1000);
    const list = await listParts(att.id, att.reportToken);
    expect(list.status).toBe(200);
    expect(await body(list)).toEqual({ uploaded: [] });
  });

  it("row 7: complete with part 3 missing answers 409 missing_parts with [3] and leaves the upload open", async () => {
    const att = await newAttachment(2 * PART_SIZE + 1000);
    expect((await putPart(att.id, 1, att.reportToken, pattern(7, 0, PART_SIZE))).status).toBe(200);
    expect((await putPart(att.id, 2, att.reportToken, pattern(7, PART_SIZE, PART_SIZE))).status).toBe(200);

    const b = await expectError(await completeUpload(att.id, att.reportToken), 409, ERRORS.missingParts);
    const lists = Object.values(b).filter(Array.isArray);
    expect(lists).toEqual([[3]]);

    const row = await attachmentById(att.id);
    expect(row!.status).toBe("uploading");
    expect(await env.FILES.head(row!.r2_key)).toBeNull();
    expect(await eventTypesOf(att.reportId)).not.toContain("file_added");
  });

  it("row 7 (edge): with only part 2 uploaded the missing list is [1, 3]", async () => {
    const att = await newAttachment(2 * PART_SIZE + 1000);
    expect((await putPart(att.id, 2, att.reportToken, pattern(7, PART_SIZE, PART_SIZE))).status).toBe(200);
    const b = await expectError(await completeUpload(att.id, att.reportToken), 409, ERRORS.missingParts);
    expect(Object.values(b).filter(Array.isArray)).toEqual([[1, 3]]);
  });

  it("row 8: a wrong, missing or other report's token on PUT part gives 401 and writes nothing", async () => {
    const att = await newAttachment(1000);
    const other = await createReport();
    const bytes = pattern(8, 0, 1000);
    const forged = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    for (const token of [forged, null, other.reportToken]) {
      await expectError(await putPart(att.id, 1, token, bytes), 401);
    }

    expect(await partRowsOf(att.id)).toBe(0);
    const list = await listParts(att.id, att.reportToken);
    expect(await body(list)).toEqual({ uploaded: [] });
    // The right token still works, so the 401s above were about the token, not a broken route.
    expect((await putPart(att.id, 1, att.reportToken, bytes)).status).toBe(200);
  });

  it.each([0, 2])("row 8 (edge): part number %i outside 1..partCount is refused and not stored", async (n) => {
    const att = await newAttachment(1000);
    const res = await putPart(att.id, n, att.reportToken, pattern(8, 0, 1000));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await partRowsOf(att.id)).toBe(0);
  });

  it("contract: GET parts with a wrong X-Report-Token gives 401", async () => {
    const att = await newAttachment(1000);
    const other = await createReport();
    await expectError(await listParts(att.id, other.reportToken), 401);
  });

  it("row 9: a fourth video/image attachment is refused with 400 too_many_files", async () => {
    const r = await createReport();
    const reportId = (await reportByCode(r.code))!.id;
    for (const mime of ["video/mp4", "image/png", "video/webm"]) {
      expect((await createAttachment(r.code, r.reportToken, { size: 1000, mime })).status, mime).toBe(201);
    }
    await expectError(
      await createAttachment(r.code, r.reportToken, { size: 1000, mime: "image/jpeg" }),
      400,
      ERRORS.tooManyFiles,
    );
    expect((await attachmentsOf(reportId)).length).toBe(3);
  });

  it.each([
    ["3 GB", 3_000_000_000],
    ["2 GiB + 1 byte", 2 * GIB + 1],
  ])("row 9: a %s file is refused with 400 file_too_large", async (_label, size) => {
    const r = await createReport();
    await expectError(await createAttachment(r.code, r.reportToken, { size }), 400, ERRORS.fileTooLarge);
    expect((await attachmentsOf((await reportByCode(r.code))!.id)).length).toBe(0);
  });

  it.each(["application/zip", "text/plain"])("row 9: mime %s is refused with 400 invalid_mime", async (mime) => {
    const r = await createReport();
    await expectError(
      await createAttachment(r.code, r.reportToken, { filename: "bug.zip", size: 1000, mime }),
      400,
      ERRORS.invalidMime,
    );
    expect((await attachmentsOf((await reportByCode(r.code))!.id)).length).toBe(0);
  });

  it("row 9 (edge): an image/png attachment is accepted as kind image", async () => {
    const att = await newAttachment(1000, "image/png");
    const row = await attachmentById(att.id);
    expect(row!.kind).toBe("image");
    expect(row!.mime).toBe("image/png");
  });

  it("contract: attach-session gives a new token for the report and the old one keeps working", async () => {
    const r = await createReport();
    const res = await call(
      `/reports/${r.code}/attach-session`,
      jsonInit("POST", { turnstileToken: TURNSTILE_PASS }, { "CF-Connecting-IP": nextIp() }),
    );
    expect(res.status).toBe(200);
    const { reportToken } = await body<{ reportToken: string }>(res);
    expect(reportToken).toMatch(/^[A-Za-z0-9_-]{43}=?$/);
    expect(reportToken).not.toBe(r.reportToken);
    expect((await createAttachment(r.code, reportToken, { size: 1000 })).status).toBe(201);
    expect((await createAttachment(r.code, r.reportToken, { size: 1000 })).status).toBe(201);
  });
});

describe("GET /status/{code}", () => {
  async function publicStatus(code: string): Promise<{ code: string; status: string; updatedAt: unknown }> {
    const res = await call(`/status/${code}`);
    expect(res.status).toBe(200);
    return body(res);
  }

  it("row 10: the code of a duplicate of a fixed report answers fixed", async () => {
    const original = await seedReport({ status: "fixed" });
    const dup = await seedReport({ status: "duplicate", duplicate_of: original.code });
    const b = await publicStatus(dup.code);
    expect(b.code).toBe(dup.code);
    expect(b.status).toBe("fixed");
    expect(b.updatedAt).toBeDefined();
  });

  it.each([
    ["received", "received"],
    ["looking", "looking"],
  ])("row 10 (not yet): a duplicate of a %s report answers %s", async (originalStatus, expected) => {
    const original = await seedReport({ status: originalStatus });
    const dup = await seedReport({ status: "duplicate", duplicate_of: original.code });
    expect((await publicStatus(dup.code)).status).toBe(expected);
  });

  it.each([
    ["not_bug", "checked"],
    ["closed", "checked"],
    ["looking", "looking"],
  ])("contract: internal status %s is shown as %s", async (internal, shown) => {
    const r = await seedReport({ status: internal });
    expect((await publicStatus(r.code)).status).toBe(shown);
  });

  it("contract: an unknown code answers 404 not_found", async () => {
    await expectError(await call("/status/LUM-000000"), 404, ERRORS.notFound);
  });
});

describe("CORS", () => {
  function preflight(path: string, origin: string, method = "POST", headers = "content-type"): Promise<Response> {
    return call(path, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers },
    });
  }

  it.each(["https://evil.test", "https://bugs.lumina.test.evil.test", "null"])(
    "row 20: preflight from the non-listed origin %s gets no Access-Control-Allow-Origin",
    async (origin) => {
      const res = await preflight("/reports", origin);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );

  it.each(["https://bugs.lumina.test", "https://preview.lumina.test"])(
    "row 20 (edge): preflight from the listed origin %s is allowed for that origin only",
    async (origin) => {
      const res = await preflight("/reports", origin);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    },
  );

  it("row 20 (edge): a POST from a listed origin carries the origin, from another origin it does not", async () => {
    const ok = await postReport({ what: uniqueText("cors"), turnstileToken: TURNSTILE_PASS }, nextIp(), {
      Origin: "https://bugs.lumina.test",
    });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://bugs.lumina.test");
    const other = await postReport({ what: uniqueText("cors"), turnstileToken: TURNSTILE_PASS }, nextIp(), {
      Origin: "https://evil.test",
    });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("contract: the upload preflight allows PUT with X-Report-Token for a listed origin", async () => {
    const res = await preflight("/attachments/some-id/parts/1", "https://bugs.lumina.test", "PUT", "x-report-token");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://bugs.lumina.test");
    expect((res.headers.get("Access-Control-Allow-Methods") ?? "").toUpperCase()).toContain("PUT");
    expect((res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase()).toContain("x-report-token");
  });

  it("contract: agent routes send no CORS headers, even to a listed origin", async () => {
    const res = await call("/agent/queue", { headers: agentHeaders({ Origin: "https://bugs.lumina.test" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const pre = await preflight("/agent/queue", "https://bugs.lumina.test", "GET", "authorization");
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
