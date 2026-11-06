// One desk detail answer exactly as the worker on main returns it for a report the agent on main triaged (both
// stages, a duplicate link, two likely files, a risk path). Nothing here is invented: every key is quoted from the
// producer that writes it (origin/main af7b731), so the desk is tested against the real shape, not the one it expects.
//
// The chain, at af7b731:
// - agent/lumina_bug_agent/run.py:183-192 runs stage A (validate_stage_a) and stage B (triage.run → validate_stage_b),
//   then post_triage; run.py:367 builds the triage object
//     {"stage_a": ..., "stage_b": ..., "files": ..., "notes": ..., "agent": AGENT_VERSION}
//   and run.py:369 posts {verdict, triage: fit_triage(triage), duplicateOf} to POST /agent/reports/{code}/triage;
//   run.py:368 sends duplicateOf only with the verdict `duplicate` (stage B's duplicate_of).
// - worker/src/routes/agent.ts:157-176 stores `triage` as JSON text (agent.ts:162 JSON.stringify(body.triage)) with
//   the verdict; a duplicate goes through worker/src/lib/duplicates.ts:72, which also sets status = 'duplicate' and
//   duplicate_of = the code.
// - worker/src/routes/desk.ts:81-100 (getReport) answers {report, attachments, duplicates}: `SELECT *` on reports
//   minus report_token_hash and ip_hash (desk.ts:82-84), with triage and game_context parsed back (desk.ts:96).

// agent/lumina_bug_agent/schemas.py:16-27 STAGE_A_SCHEMA: these nine keys exactly (validate_stage_a, schemas.py:39).
export type AgentStageA = {
  what: string
  where: string
  when_in_video: string | null
  device: string | null
  steps: string[]
  expected: string | null
  actual: string | null
  language: string
  injection_suspected: boolean
}

// schemas.py:88-104 STAGE_B_SCHEMA: these seven keys exactly (validate_stage_b, schemas.py:126); likely_files items
// are {path, line, why} (schemas.py:96-99, line an integer >= 0 or null); fix_size in FIX_SIZES (schemas.py:82).
export type AgentStageB = {
  verdict: 'simple_fix' | 'needs_person' | 'duplicate' | 'not_bug' | 'unclear'
  confidence: number
  summary: string
  likely_files: { path: string; line: number | null; why: string }[]
  risk_paths: string[]
  duplicate_of: string | null
  fix_size: 'small' | 'medium' | 'large' | 'unknown'
}

// run.py:367. `files`: one entry per complete video or image (run.py:321-339): {"id", "status": "ok", "kind",
// and for a video "duration", "frames", "sheets"} (run.py:355-360), or {"id", "status": "skipped", "reason"}.
// `notes`: [] after both stages (run.py:191), ["stage_a_invalid"] / ["stage_b_invalid"] when a stage failed.
// `agent`: AGENT_VERSION, agent/lumina_bug_agent/__init__.py:5.
export type AgentTriage = {
  stage_a: AgentStageA | null
  stage_b: AgentStageB | null
  files: Record<string, unknown>[]
  notes: string[]
  agent: string
}

// worker/migrations/0001_init.sql:2-9, every column but report_token_hash and ip_hash (desk.ts:84).
export type DeskReportRowMain = {
  id: string
  code: string
  created_at: number
  updated_at: number
  source: 'web' | 'game' | 'discord'
  status: 'received' | 'looking' | 'fixed' | 'duplicate' | 'not_bug' | 'closed'
  title: string | null
  what: string
  where_area: string | null
  device: string | null
  lang: string | null
  roblox_name: string | null
  roblox_user_id: number | null
  discord_user_id: string | null
  discord_name: string | null
  discord_thread_id: string | null
  game_context: unknown
  verdict: AgentStageB['verdict'] | null
  triage: AgentTriage | null
  duplicate_of: string | null
  pr_url: string | null
  lease_until: number | null
  lease_by: string | null
}

// desk.ts:86-89 (attachment columns) and desk.ts:92-98 (codes of reports whose duplicate_of is this one).
export type DeskDetailMain = {
  report: DeskReportRowMain
  attachments: {
    id: string
    kind: 'video' | 'image' | 'frames'
    filename: string
    mime: string
    size_bytes: number
    status: 'uploading' | 'complete' | 'aborted' | 'deleted'
    created_at: number
    completed_at: number | null
  }[]
  duplicates: string[]
}

export const CODE = 'LUM-482540'
// The report this one is the same as: in the cache's offer list, so validate_stage_b keeps it (schemas.py:149-153).
export const ORIGINAL = 'LUM-482193'

const CREATED = 1_762_400_000_000
const TRIAGED = CREATED + 25 * 60_000
const VIDEO = '01JBRIDGEVIDEO0000000000AA'
const FRAMES = '01JBRIDGEFRAMES000000000AB'

const TRIAGE_REAL: DeskDetailMain = {
  report: {
    id: '01JBRIDGEREPORT0000000000A',
    code: CODE,
    created_at: CREATED,
    updated_at: TRIAGED,
    source: 'web',
    // duplicates.ts:72: a duplicate verdict links the report and sets its status.
    status: 'duplicate',
    title: null,
    // The player's own text: never the AI's (the triage panel shows stage A's reading of it, not this).
    what: 'boss stuck on bridge again!! it just stands there',
    where_area: 'match',
    device: 'tablet',
    lang: 'en',
    roblox_name: null,
    roblox_user_id: null,
    discord_user_id: null,
    discord_name: null,
    discord_thread_id: null,
    game_context: null,
    verdict: 'duplicate',
    triage: {
      stage_a: {
        what: 'On the Bridge map the boss waits forever at the last waypoint',
        where: 'match, Bridge map',
        when_in_video: '1:52',
        device: 'tablet',
        steps: ['Start a match on the Bridge map', 'Reach the boss wave', 'Watch the boss at the last waypoint'],
        expected: 'The boss walks to the base',
        actual: 'The boss stands still at the last waypoint',
        language: 'en',
        injection_suspected: false,
      },
      stage_b: {
        verdict: 'duplicate',
        confidence: 0.82,
        summary: 'BossPath expects nine waypoints while the Bridge path has eight, so the boss never reaches the end',
        likely_files: [
          { path: 'src/server/Waves/BossPath.luau', line: 212, why: 'reads waypoint nine, which Bridge lacks' },
          { path: 'src/shared/Maps/Bridge/Waypoints.luau', line: 8, why: 'the Bridge path ends at waypoint eight' },
        ],
        // A path on the risk list (agent/lumina_bug_agent/guard.py:9-13, `**/Network*`).
        risk_paths: ['src/server/Network/WaveSync.luau'],
        duplicate_of: ORIGINAL,
        fix_size: 'medium',
      },
      files: [{ id: VIDEO, status: 'ok', kind: 'video', duration: 161.4, frames: 24, sheets: 2 }],
      notes: [],
      agent: 'lumina-bug-agent/1',
    },
    duplicate_of: ORIGINAL,
    pr_url: null,
    // The agent's claim (agent.ts:68-71, config.py:112-113 defaults): triage does not clear it.
    lease_until: TRIAGED - 5 * 60_000 + 60 * 60_000,
    lease_by: 'valor1-agent',
  },
  attachments: [
    {
      id: VIDEO,
      kind: 'video',
      filename: 'boss-bridge.mp4',
      mime: 'video/mp4',
      size_bytes: 540_000_000,
      status: 'complete',
      created_at: CREATED + 60_000,
      completed_at: CREATED + 9 * 60_000,
    },
    {
      // agent.ts:136-139: frames rows are complete at once, named from run.py:168's X-Filename.
      id: FRAMES,
      kind: 'frames',
      filename: `frames-${VIDEO}-1.jpg`,
      mime: 'image/jpeg',
      size_bytes: 412_000,
      status: 'complete',
      created_at: TRIAGED - 2 * 60_000,
      completed_at: TRIAGED - 2 * 60_000,
    },
  ],
  duplicates: [],
}

// A fresh copy every call: a spec that varies one field never leaks into another.
export const triageReal = (): DeskDetailMain => structuredClone(TRIAGE_REAL)
