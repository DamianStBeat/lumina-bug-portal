// Internal status -> public status (CONTRACT.md "Statuses"); a duplicate answers with its original's.
import type { PublicStatus } from "./validate";

const PUBLIC: Record<string, PublicStatus> = {
  received: "received", looking: "looking", fixed: "fixed", not_bug: "checked", closed: "checked",
};
// Longer chains, and loops (A -> B -> A), stop here instead of walking the table.
const MAX_DUPLICATE_DEPTH = 5;

type StatusRow = { status: string; duplicate_of: string | null; updated_at: number };

/**
 * The status a player sees, and the latest `updated_at` along the duplicate chain (a duplicate moves when its
 * original does). A duplicate whose original is missing, loops or is too deep shows `checked`: someone did look at
 * it and linked it, which is what `checked` tells the player.
 */
export async function resolvePublicStatus(env: Env, row: StatusRow): Promise<{ status: PublicStatus; updatedAt: number }> {
  let updatedAt = row.updated_at;
  for (let depth = 0; row.status === "duplicate"; depth++) {
    if (!row.duplicate_of || depth >= MAX_DUPLICATE_DEPTH) return { status: "checked", updatedAt };
    const next = await env.DB.prepare("SELECT status, duplicate_of, updated_at FROM reports WHERE code = ?")
      .bind(row.duplicate_of)
      .first<StatusRow>();
    if (!next) return { status: "checked", updatedAt };
    row = next;
    updatedAt = Math.max(updatedAt, next.updated_at);
  }
  // An unknown internal value can only come from a bad write; `looking` promises nothing untrue.
  return { status: PUBLIC[row.status] ?? "looking", updatedAt };
}
