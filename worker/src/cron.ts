// The daily retention of CONTRACT.md "Limits" > Retention, run by the `0 3 * * *` trigger.
//
// Every step works in bounded batches and the whole run has an R2 budget, so a backlog (the first run after an
// outage, a flood of reports) never pushes one invocation past the Workers limits: what is left waits for tomorrow.
// One object that fails is logged by attachment id (never its key, which names a player's file) and skipped.

const DAY_MS = 86_400_000;
const MEDIA_DAYS = 60;
const UPLOAD_DAYS = 7;
const REPORT_DAYS = 365;
const HASH_DAYS = 2;

const BATCH = 100;
const MAX_BATCHES = 10;
// R2 calls per run, well under the per-invocation subrequest limit even with the D1 queries added.
const R2_BUDGET = 500;

type Budget = { r2: number };

const NO_SUCH_UPLOAD = /\(10024\)|multipart upload does not exist/i;

/** Aborts an R2 multipart upload; one that R2 no longer knows (aborted or completed earlier) counts as done. */
async function abortUpload(env: Env, key: string, uploadId: string): Promise<void> {
  try {
    await env.FILES.resumeMultipartUpload(key, uploadId).abort();
  } catch (err) {
    if (!(err instanceof Error && NO_SUCH_UPLOAD.test(err.message))) throw err;
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs `step` on batches from `select` until a batch is short, nothing in it succeeded (the rest are failures that
 * would come back forever), the batch cap or the R2 budget is reached.
 */
async function inBatches<T>(budget: Budget, select: () => Promise<T[]>, step: (rows: T[]) => Promise<number>) {
  for (let i = 0; i < MAX_BATCHES && budget.r2 > 0; i++) {
    const rows = await select();
    if (rows.length === 0) return;
    const done = await step(rows);
    if (done === 0 || rows.length < BATCH) return;
  }
}

/** Video and image objects 60 days after their report was made; the row stays, marked `deleted`. */
async function expireMedia(env: Env, now: number, budget: Budget) {
  type Row = { id: string; r2_key: string };
  await inBatches<Row>(
    budget,
    async () =>
      (
        await env.DB.prepare(
          `SELECT a.id, a.r2_key FROM attachments a JOIN reports r ON r.id = a.report_id
           WHERE a.kind IN ('video', 'image') AND a.status = 'complete' AND r.created_at < ? LIMIT ${BATCH}`,
        )
          .bind(now - MEDIA_DAYS * DAY_MS)
          .all<Row>()
      ).results,
    async (rows) => {
      const done: string[] = [];
      for (const row of rows.slice(0, budget.r2)) {
        budget.r2--;
        try {
          await env.FILES.delete(row.r2_key);
          done.push(row.id);
        } catch (err) {
          console.error("retention: media delete failed", row.id, reason(err));
        }
      }
      const update = env.DB.prepare("UPDATE attachments SET status = 'deleted' WHERE id = ? AND status = 'complete'");
      if (done.length) await env.DB.batch(done.map((id) => update.bind(id)));
      return done.length;
    },
  );
}

/** Uploads still open after 7 days: aborted in R2 (its stored parts go with it), row `aborted`, parts rows dropped. */
async function abortStaleUploads(env: Env, now: number, budget: Budget) {
  type Row = { id: string; r2_key: string; upload_id: string | null };
  await inBatches<Row>(
    budget,
    async () =>
      (
        await env.DB.prepare(
          `SELECT id, r2_key, upload_id FROM attachments WHERE status = 'uploading' AND created_at < ? LIMIT ${BATCH}`,
        )
          .bind(now - UPLOAD_DAYS * DAY_MS)
          .all<Row>()
      ).results,
    async (rows) => {
      const done: string[] = [];
      for (const row of rows.slice(0, budget.r2)) {
        budget.r2--;
        try {
          if (row.upload_id) await abortUpload(env, row.r2_key, row.upload_id);
          done.push(row.id);
        } catch (err) {
          console.error("retention: upload abort failed", row.id, reason(err));
        }
      }
      const mark = env.DB.prepare("UPDATE attachments SET status = 'aborted' WHERE id = ? AND status = 'uploading'");
      const parts = env.DB.prepare("DELETE FROM parts WHERE attachment_id = ?");
      if (done.length) await env.DB.batch(done.flatMap((id) => [mark.bind(id), parts.bind(id)]));
      return done.length;
    },
  );
}

/**
 * Reports older than 12 months, with everything that hangs off them. A report whose objects could not all be
 * removed keeps its rows, so tomorrow's run still knows the keys instead of leaving files nobody can find.
 */
async function deleteOldReports(env: Env, now: number, budget: Budget) {
  type Att = { id: string; r2_key: string; upload_id: string | null; status: string };
  await inBatches<{ id: string }>(
    budget,
    async () =>
      (
        await env.DB.prepare(`SELECT id FROM reports WHERE created_at < ? ORDER BY created_at LIMIT ${BATCH}`)
          .bind(now - REPORT_DAYS * DAY_MS)
          .all<{ id: string }>()
      ).results,
    async (reports) => {
      let done = 0;
      for (const report of reports) {
        const { results: atts } = await env.DB.prepare(
          "SELECT id, r2_key, upload_id, status FROM attachments WHERE report_id = ?",
        )
          .bind(report.id)
          .all<Att>();
        const live = atts.filter((a) => a.status === "complete" || a.status === "uploading");
        if (live.length > budget.r2) break;
        let clean = true;
        for (const a of live) {
          budget.r2--;
          try {
            if (a.status === "uploading" && a.upload_id) await abortUpload(env, a.r2_key, a.upload_id);
            else await env.FILES.delete(a.r2_key);
          } catch (err) {
            clean = false;
            console.error("retention: old report object failed", a.id, reason(err));
          }
        }
        if (!clean) continue;
        // One transaction; report_tokens would go by ON DELETE CASCADE, deleted here too so nothing relies on it.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM parts WHERE attachment_id IN (SELECT id FROM attachments WHERE report_id = ?)").bind(report.id),
          env.DB.prepare("DELETE FROM attachments WHERE report_id = ?").bind(report.id),
          env.DB.prepare("DELETE FROM events WHERE report_id = ?").bind(report.id),
          env.DB.prepare("DELETE FROM report_tokens WHERE report_id = ?").bind(report.id),
          env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(report.id),
        ]);
        done++;
      }
      return done;
    },
  );
}

/** D1-only clean-ups, in bounded chunks: ip hashes after 2 days, rate rows whose window started over 2 days ago. */
async function dropOldHashes(env: Env, now: number) {
  const cutoff = now - HASH_DAYS * DAY_MS;
  const statements = [
    env.DB.prepare(
      `UPDATE reports SET ip_hash = NULL WHERE id IN
         (SELECT id FROM reports WHERE ip_hash IS NOT NULL AND created_at < ? LIMIT 1000)`,
    ).bind(cutoff),
    env.DB.prepare('DELETE FROM rate WHERE rowid IN (SELECT rowid FROM rate WHERE "window" < ? LIMIT 1000)').bind(cutoff),
  ];
  for (const statement of statements) {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await statement.run();
      if (result.meta.changes < 1000) break;
    }
  }
}

export async function runRetention(env: Env): Promise<void> {
  const now = Date.now();
  const budget: Budget = { r2: R2_BUDGET };
  // Oldest reports first: deleting them also removes media and uploads the later steps would otherwise touch.
  const steps: [string, () => Promise<void>][] = [
    ["old reports", () => deleteOldReports(env, now, budget)],
    ["media", () => expireMedia(env, now, budget)],
    ["uploads", () => abortStaleUploads(env, now, budget)],
    ["hashes", () => dropOldHashes(env, now)],
  ];
  let failed = 0;
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      // One step failing (D1 hiccup) still lets the others run; the run as a whole is reported as failed below.
      failed++;
      console.error("retention: step failed", name, reason(err));
    }
  }
  if (failed > 0) throw new Error(`retention: ${failed} step(s) failed`);
}
