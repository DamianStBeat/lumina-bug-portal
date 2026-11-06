// The daily retention of CONTRACT.md "Limits" > Retention, run by the `0 3 * * *` trigger.
//
// Every step works in bounded batches and the whole run has an R2 budget, so a backlog (the first run after an
// outage, a flood of reports) never pushes one invocation past the Workers limits: what is left waits for tomorrow.
// One object that fails is logged by attachment id (never its key, which names a player's file) and skipped.
import { ABORT_R2_CALLS, abortUpload } from "./lib/uploads";

const DAY_MS = 86_400_000;
const MEDIA_DAYS = 60;
const UPLOAD_DAYS = 7;
const REPORT_DAYS = 365;
const HASH_DAYS = 2;

const BATCH = 100;
const MAX_BATCHES = 10;
// R2 calls per run, well under the per-invocation subrequest limit even with the D1 queries added. An abort that
// finds a finished object makes one uncharged delete more; such objects only exist after a failed D1 write.
const R2_BUDGET = 500;

// `failures` counts the objects a step logged and skipped: the run still throws at the end, so the cron shows as
// failed instead of reporting success over work it left for tomorrow.
type Budget = { r2: number; failures: number };

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
          budget.failures++;
          console.error("retention: media delete failed", row.id, reason(err));
        }
      }
      const update = env.DB.prepare("UPDATE attachments SET status = 'deleted' WHERE id = ? AND status = 'complete'");
      if (done.length) await env.DB.batch(done.map((id) => update.bind(id)));
      return done.length;
    },
  );
}

/**
 * Uploads still open after 7 days: aborted in R2 (its stored parts go with it), row `aborted` with its upload id
 * cleared, parts rows dropped. One R2 already completed (its D1 write failed) has its object deleted and its row
 * marked `deleted` instead.
 *
 * The row is claimed in D1 before R2 is touched. A complete that lands first keeps its row and its object (the claim
 * changes nothing); one that lands after the claim finds its own D1 write refused and answers 409, so no player is
 * told "ok" for a file this step then deletes.
 *
 * An `aborted` row that still has its upload id is a claim whose R2 work never finished (the abort failed, or the
 * D1 write after it did), or a player's DELETE: it is picked up again here, so a failed run is retried the next day,
 * not when the report reaches 12 months. Every R2 call is idempotent (an abort of a gone upload is "no such upload",
 * a head then finds the object or not), and clearing the upload id is what marks the row as done.
 */
async function abortStaleUploads(env: Env, now: number, budget: Budget) {
  type Row = { id: string; r2_key: string; upload_id: string | null; status: string };
  // A cursor on id, so a row that failed is not selected again in this run: tomorrow's run retries it.
  let after = "";
  await inBatches<Row>(
    budget,
    async () =>
      (
        await env.DB.prepare(
          `SELECT id, r2_key, upload_id, status FROM attachments
           WHERE (status = 'uploading' OR (status = 'aborted' AND upload_id IS NOT NULL)) AND created_at < ? AND id > ?
           ORDER BY id LIMIT ${BATCH}`,
        )
          .bind(now - UPLOAD_DAYS * DAY_MS, after)
          .all<Row>()
      ).results,
    async (rows) => {
      const claim = env.DB.prepare("UPDATE attachments SET status = 'aborted' WHERE id = ? AND status = 'uploading'");
      const handled: { id: string; found: boolean }[] = [];
      // Rows a complete took first are no longer `uploading`: they count as handled, the next select skips them.
      let skipped = 0;
      for (const row of rows) {
        if (budget.r2 < ABORT_R2_CALLS) break;
        after = row.id;
        if (row.status === "uploading" && (await claim.bind(row.id).run()).meta.changes !== 1) {
          skipped++;
          continue;
        }
        budget.r2 -= ABORT_R2_CALLS;
        try {
          handled.push({ id: row.id, found: row.upload_id !== null && (await abortUpload(env.FILES, row.r2_key, row.upload_id)) });
        } catch (err) {
          // The row stays `aborted` with its upload id, which is what brings it back tomorrow.
          budget.failures++;
          console.error("retention: upload abort failed", row.id, reason(err));
        }
      }
      const mark = env.DB.prepare(
        "UPDATE attachments SET status = CASE WHEN ?2 = 1 THEN 'deleted' ELSE status END, upload_id = NULL WHERE id = ?1 AND status = 'aborted'",
      );
      const parts = env.DB.prepare("DELETE FROM parts WHERE attachment_id = ?");
      const statements = handled.flatMap(({ id, found }) => [mark.bind(id, found ? 1 : 0), parts.bind(id)]);
      if (statements.length) await env.DB.batch(statements);
      return handled.length + skipped;
    },
  );
}

type OldAtt = { id: string; r2_key: string; upload_id: string | null; status: string };

/**
 * Removes the objects of one old report's attachments, a page at a time within the budget. Every row is covered,
 * whatever its status: an `uploading` or `aborted` row may still hold an open upload or a finished object (a
 * stale-upload abort that has not succeeded yet), a `deleted` one is deleted again, which R2 treats as a no-op. Each attachment row
 * goes, with its parts, as soon as its object is gone, so a report with more objects than one day's budget moves
 * forward every run and the rows still there are exactly the objects left to remove. Rows are deleted by id: a frame
 * the agent adds while this runs is not in our list and stays for the next run. Returns false when the budget ran out
 * before the end of the list.
 */
async function purgeAttachments(env: Env, reportId: string, budget: Budget): Promise<boolean> {
  const dropParts = env.DB.prepare("DELETE FROM parts WHERE attachment_id = ?");
  const dropRow = env.DB.prepare("DELETE FROM attachments WHERE id = ?");
  // A cursor on id, so a row that failed is not selected again in this run: tomorrow's run retries it.
  let after = "";
  for (;;) {
    const { results: atts } = await env.DB.prepare(
      `SELECT id, r2_key, upload_id, status FROM attachments WHERE report_id = ? AND id > ? ORDER BY id LIMIT ${BATCH}`,
    )
      .bind(reportId, after)
      .all<OldAtt>();
    const gone: string[] = [];
    let complete = true;
    for (const a of atts) {
      // A `complete` or `deleted` row's upload was finished by R2 before the row got there: a delete is enough.
      const open = (a.status === "uploading" || a.status === "aborted") && a.upload_id !== null;
      const cost = open ? ABORT_R2_CALLS : 1;
      if (cost > budget.r2) {
        complete = false;
        break;
      }
      budget.r2 -= cost;
      after = a.id;
      try {
        if (open) await abortUpload(env.FILES, a.r2_key, a.upload_id!);
        else await env.FILES.delete(a.r2_key);
        gone.push(a.id);
      } catch (err) {
        budget.failures++;
        console.error("retention: old report object failed", a.id, reason(err));
      }
    }
    if (gone.length) await env.DB.batch(gone.flatMap((id) => [dropParts.bind(id), dropRow.bind(id)]));
    if (!complete) return false;
    if (atts.length < BATCH) return true;
  }
}

/**
 * Reports older than 12 months, with everything that hangs off them. The report row goes only once no attachment
 * row is left: one whose object could not be removed keeps its row (and so the report), so tomorrow's run still knows
 * the key instead of leaving a file nobody can find. A cursor walks past such a report, so the ones behind it are
 * still reached in the same run.
 */
async function deleteOldReports(env: Env, now: number, budget: Budget) {
  type Row = { id: string; created_at: number };
  let cursor: Row = { id: "", created_at: -1 };
  for (let i = 0; i < MAX_BATCHES && budget.r2 > 0; i++) {
    const { results: reports } = await env.DB.prepare(
      `SELECT id, created_at FROM reports WHERE created_at < ?1 AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
       ORDER BY created_at, id LIMIT ${BATCH}`,
    )
      .bind(now - REPORT_DAYS * DAY_MS, cursor.created_at, cursor.id)
      .all<Row>();
    for (const report of reports) {
      if (!(await purgeAttachments(env, report.id, budget))) return;
      cursor = report;
      // One transaction. Each statement re-checks in D1 that nothing still hangs off the report, so an attachment
      // added after our list was read keeps the report (and its key) for the next run. report_tokens would go by
      // ON DELETE CASCADE, deleted here too so nothing relies on it.
      const orphan = "NOT EXISTS (SELECT 1 FROM reports WHERE id = ?1)";
      await env.DB.batch([
        env.DB.prepare("DELETE FROM reports WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM attachments WHERE report_id = ?1)").bind(report.id),
        env.DB.prepare(`DELETE FROM events WHERE report_id = ?1 AND ${orphan}`).bind(report.id),
        env.DB.prepare(`DELETE FROM report_tokens WHERE report_id = ?1 AND ${orphan}`).bind(report.id),
      ]);
    }
    if (reports.length < BATCH) return;
  }
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
  const budget: Budget = { r2: R2_BUDGET, failures: 0 };
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
  if (failed > 0 || budget.failures > 0) {
    throw new Error(`retention: ${failed} step(s) failed, ${budget.failures} object(s) left for the next run`);
  }
}
