// The append-only `events` log the agent and bot read through GET /agent/events.

export type EventType = "created" | "file_added" | "triaged" | "status_changed" | "duplicate_linked";
type Data = Record<string, unknown>;

/** The insert as a statement, for a `DB.batch` that writes the event in the same transaction as its change. */
export const eventStatement = (env: Env, reportId: string, type: EventType, data: Data = {}, at = Date.now()) =>
  env.DB.prepare("INSERT INTO events (report_id, at, type, data) VALUES (?, ?, ?, ?)").bind(reportId, at, type, JSON.stringify(data));

export async function appendEvent(env: Env, reportId: string, type: EventType, data: Data = {}): Promise<void> {
  await eventStatement(env, reportId, type, data).run();
}
