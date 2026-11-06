-- CONTRACT.md "D1 schema", plus report_tokens (tokens issued by attach-session) and the indexes the queries need.
CREATE TABLE reports (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, status TEXT NOT NULL, title TEXT, what TEXT NOT NULL,
  where_area TEXT, device TEXT, lang TEXT, roblox_name TEXT, roblox_user_id INTEGER,
  discord_user_id TEXT, discord_name TEXT, discord_thread_id TEXT, game_context TEXT,
  report_token_hash TEXT NOT NULL, ip_hash TEXT, verdict TEXT, triage TEXT, duplicate_of TEXT, pr_url TEXT,
  lease_until INTEGER, lease_by TEXT
);
-- The UNIQUE on code already indexes the lookup by code.
CREATE INDEX reports_status_created ON reports (status, created_at);
CREATE INDEX reports_created ON reports (created_at);
CREATE INDEX reports_roblox_user ON reports (roblox_user_id, updated_at);
CREATE INDEX reports_duplicate_of ON reports (duplicate_of);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, r2_key TEXT NOT NULL, upload_id TEXT,
  part_size INTEGER, part_count INTEGER, status TEXT NOT NULL, completed_at INTEGER
);
CREATE INDEX attachments_report ON attachments (report_id);
CREATE INDEX attachments_status_created ON attachments (status, created_at);

CREATE TABLE parts (attachment_id TEXT, n INTEGER, etag TEXT, size INTEGER, PRIMARY KEY (attachment_id, n));

CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, at INTEGER, type TEXT, data TEXT);
CREATE INDEX events_report ON events (report_id);

-- "window" = start of the fixed window in unix ms (src/lib/rate.ts), so retention can drop rows by age.
CREATE TABLE rate (key TEXT, "window" INTEGER, count INTEGER, PRIMARY KEY (key, "window"));

-- The contract keeps one report_token_hash per report (the creation token). Tokens issued later by attach-session
-- land here, so the old ones stay valid; deleting a report deletes its extra tokens.
CREATE TABLE report_tokens (
  report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, token_hash)
);
