// The one write path for a duplicate link (CONTRACT.md "Agent and bot" triage, and both status routes): triage and a
// person setting `duplicate` by hand go through the same root lookup, the same cycle guard and the same re-pointing,
// so neither can store a link the other would refuse.
import { CODE_PATTERN } from "./codes";
import { type EventType } from "./events";
import { HttpError } from "./http";
import { reportOf } from "./reports";
import { MAX_DUPLICATE_DEPTH } from "./status";

const CODE_RE = new RegExp(`^${CODE_PATTERN}$`);
// A chain that moved under both attempts moved twice in a few milliseconds: one second lets it settle.
const BUSY_RETRY_SECONDS = 1;

/**
 * The `duplicateOf` of a request that sets `duplicate` (`linking`) or any other status. A link only with `duplicate`,
 * to another report's code: a stray one is a caller bug, and `duplicate` without one would be a link to nothing.
 * Existence is checked later, by rootOriginal.
 */
export function duplicateTarget(linking: boolean, raw: unknown, self: string): string | null {
  if (!linking) {
    if (raw !== undefined && raw !== null) throw new HttpError(400, "invalid_duplicate_of");
    return null;
  }
  if (typeof raw !== "string" || !CODE_RE.test(raw) || raw === self) throw new HttpError(400, "invalid_duplicate_of");
  return raw;
}

type Bind = string | number | null;

/** What differs between the callers: their own columns and their own status_changed data; the link SQL is shared. */
export type LinkWrites = {
  /** Assignments the report's own UPDATE adds beside status, duplicate_of and updated_at, e.g. `verdict = ?, `. */
  set: string;
  setBinds: Bind[];
  /** `, 'key', ?` pairs the status_changed event adds after `from` and `to`. */
  eventPairs: string;
  eventBinds: Bind[];
  /** Triage records a status change only when the stored status differs; a person's change is recorded every time. */
  onlyOnChange: boolean;
  /** Events written with the link, before duplicate_linked (triage's `triaged`). */
  events: { type: EventType; data: Record<string, unknown> }[];
};

/**
 * Links report `code` to the root original of `target`, with the caller's own columns and events, all in one
 * transaction. 404 `not_found` when the report is gone, 400 `invalid_duplicate_of` when the target is, 409
 * `duplicate_cycle` when the link would close a loop, 409 `duplicate_busy` when the chain moved under both attempts.
 */
export async function linkDuplicate(env: Env, code: string, target: string, own: LinkWrites): Promise<void> {
  // The chain is read first (rootOriginal), then written; another link may land in between (B -> A landing while
  // A -> B is between its read and its write would store A -> B -> A), and retention may delete either report. So
  // every statement of the batch re-checks what the read decided, inside the transaction: a stale read writes nothing.
  // It is then read again once, which turns into 404, 400 or 409 duplicate_cycle when the world changed for good, or
  // links to the root the chain moved to.
  for (let attempt = 1; ; attempt++) {
    const report = await reportOf(env, code);
    const root = await rootOriginal(env, target, code);
    const duplicateOf = root.code;
    const guard = cycleGuard(root, code, report.id);
    const now = Date.now();
    const linked = JSON.stringify({ duplicateOf });
    const onChange = own.onlyOnChange ? " AND status <> 'duplicate'" : "";
    const [, updated] = await env.DB.batch([
      // The event first, its `from` read from the row inside the transaction: a change landing after our lookup is
      // never recorded with a stale previous status.
      env.DB.prepare(
        `INSERT INTO events (report_id, at, type, data)
         SELECT id, ?, 'status_changed', json_object('from', status, 'to', 'duplicate'${own.eventPairs}) FROM reports
         WHERE id = ?${onChange} AND ${guard.sql}`,
      ).bind(now, ...own.eventBinds, report.id, ...guard.binds),
      env.DB.prepare(`UPDATE reports SET ${own.set}status = 'duplicate', duplicate_of = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`)
        .bind(...own.setBinds, duplicateOf, now, report.id, ...guard.binds),
      // After the report's own UPDATE the guard still answers the same: it reads the root's row and the chain from
      // the root, and neither contains this report (the guard just said so), so changing this row moves neither.
      ...own.events.map((e) => guardedEvent(env, report.id, e.type, JSON.stringify(e.data), now, guard)),
      guardedEvent(env, report.id, "duplicate_linked", linked, now, guard),
      // Each report re-pointed below gets the event the bot posts "Same bug" from, as this one does: the same data
      // string, written before the UPDATE moves them and while they still point here. Same row set as the UPDATE.
      env.DB.prepare(
        `INSERT INTO events (report_id, at, type, data) SELECT id, ?, 'duplicate_linked', ? FROM reports
         WHERE status = 'duplicate' AND duplicate_of = ? AND code <> ? AND ${guard.sql}`,
      ).bind(now, linked, code, duplicateOf, ...guard.binds),
      // Reports already linked to this one were linked while it was an original; now that it points at a root, they
      // point there too. Storing the root covers links made later, this covers the ones made earlier, so every chain
      // stays one hop whatever order the links are made in, and the read guard's depth limit is never reached.
      // Only rows still in `duplicate` move: a report a person un-duplicated keeps its stored duplicate_of, untouched.
      // The root itself is never one of them: it may still point here from before a person un-duplicated it, and
      // moving it would link it to itself.
      env.DB.prepare(
        `UPDATE reports SET duplicate_of = ? WHERE status = 'duplicate' AND duplicate_of = ? AND code <> ? AND ${guard.sql}`,
      ).bind(duplicateOf, code, duplicateOf, ...guard.binds),
    ]);
    if (updated!.meta.changes === 1) return;
    if (attempt === 2) {
      // A report retention removed meanwhile is 404, as on the first lookup. Anything else is a chain that moved under
      // both attempts: "not yet", not "no", so the caller is told to retry rather than that the link is a loop.
      await reportOf(env, code);
      throw new HttpError(409, "duplicate_busy", { body: { retryAfter: BUSY_RETRY_SECONDS }, headers: { "Retry-After": String(BUSY_RETRY_SECONDS) } });
    }
  }
}

type Guard = { sql: string; binds: Bind[] };

/** An event row, written only while `guard` holds; `data` is the JSON string eventStatement would store. */
function guardedEvent(env: Env, reportId: string, type: EventType, data: string, at: number, guard: Guard): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO events (report_id, at, type, data) SELECT ?, ?, ?, ? WHERE ${guard.sql}`)
    .bind(reportId, at, type, data, ...guard.binds);
}

/**
 * What rootOriginal decided, as one SQL condition every statement of the write repeats: the report itself still
 * exists (retention may have deleted it since the lookup, and an event on its id would be an orphan); the root's row
 * still exists and points where it did (nowhere, for an original: a root that became a duplicate meanwhile would make
 * the chain two hops); and the chain from the root, through duplicate rows only, never reaches `self` (the link would
 * close a loop). The walk goes one step past the read limit, so a long chain that loops back to `self` is still seen;
 * the depth bound also stops it on a loop that does not.
 */
function cycleGuard(root: Root, self: string, selfId: string): Guard {
  return {
    sql: `EXISTS (SELECT 1 FROM reports WHERE id = ?)
      AND EXISTS (SELECT 1 FROM reports WHERE code = ? AND (CASE WHEN status = 'duplicate' THEN duplicate_of END) IS ?)
      AND NOT EXISTS (
        WITH RECURSIVE chain(code, depth) AS (
          SELECT ?, 0
          UNION ALL
          SELECT r.duplicate_of, c.depth + 1 FROM chain c JOIN reports r ON r.code = c.code
          WHERE r.status = 'duplicate' AND r.duplicate_of IS NOT NULL AND c.depth < ${MAX_DUPLICATE_DEPTH + 1}
        )
        SELECT 1 FROM chain WHERE code = ?)`,
    binds: [selfId, root.code, root.next, root.code, self],
  };
}

/** The report a duplicate link stores, and where its row pointed when read (null for an original). */
type Root = { code: string; next: string | null };

/**
 * The original a duplicate link stores: `target`, or the report its own duplicate chain ends at, so a player's status
 * is one hop away. 400 `invalid_duplicate_of` when `target` does not exist; 409 `duplicate_cycle` when the chain
 * comes back to `self` (the link would close a loop) or already loops. A chain broken by a missing original, or
 * longer than the read-time limit, stops at the last report found.
 */
async function rootOriginal(env: Env, target: string, self: string): Promise<Root> {
  const seen = new Set([self, target]);
  let found: Root | null = null;
  let code = target;
  for (let depth = 0; depth < MAX_DUPLICATE_DEPTH; depth++) {
    const row = await env.DB.prepare("SELECT status, duplicate_of FROM reports WHERE code = ?")
      .bind(code)
      .first<{ status: string; duplicate_of: string | null }>();
    if (!row) break;
    const next = row.status === "duplicate" ? row.duplicate_of : null;
    found = { code, next };
    if (!next) break;
    if (seen.has(next)) throw new HttpError(409, "duplicate_cycle");
    seen.add(next);
    code = next;
  }
  if (found === null) throw new HttpError(400, "invalid_duplicate_of");
  return found;
}
