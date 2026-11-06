// Request and response shapes of CONTRACT.md "HTTP API (worker)". Public shapes follow the contract's tables.
// Desk shapes are not detailed in the contract: the `*Wire` types are what worker/src/routes/desk.ts answers (D1
// columns, snake_case, null when empty); the client turns them into the camelCase shapes the pages read.

export type WhereArea = 'match' | 'lobby' | 'shop' | 'crates' | 'clan' | 'other'
export type Device = 'phone' | 'tablet' | 'computer' | 'console'
export type PublicStatus = 'received' | 'looking' | 'fixed' | 'checked'

// Every error is `{error: "<snake_case>"}`. 409 `missing_parts` comes "with the list": the field name is not
// fixed by the contract, `missing` is our guess.
export type ApiErrorBody = { error: string; missing?: number[] }

export type CreateReportBody = {
  what: string
  where?: WhereArea
  device?: Device
  robloxName?: string
  lang?: string
  turnstileToken: string
}
export type CreateReportRes = { code: string; reportToken: string }

export type AttachSessionBody = { turnstileToken: string }
export type AttachSessionRes = { reportToken: string }

export type CreateAttachmentBody = { filename: string; size: number; mime: string }
export type CreateAttachmentRes = { attachmentId: string; partSize: number; partCount: number }

export type PutPartRes = { n: number; etag: string }
export type ListPartsRes = { uploaded: { n: number; size: number }[] }
export type OkRes = { ok: true }

// updatedAt: unix ms, as every timestamp in the D1 schema.
export type StatusRes = { code: string; status: PublicStatus; updatedAt: number }

// ---- Desk (team only) ----

export type ReportStatus = 'received' | 'looking' | 'fixed' | 'duplicate' | 'not_bug' | 'closed'
export type Verdict = 'simple_fix' | 'needs_person' | 'duplicate' | 'not_bug' | 'unclear'
export type ReportSource = 'web' | 'game' | 'discord'
export type AttachmentKind = 'video' | 'image' | 'frames'
export type AttachmentStatus = 'uploading' | 'complete' | 'aborted' | 'deleted'
export type DeskFilter = 'all' | 'fix_ready' | 'needs_person' | 'duplicate' | 'not_bug' | 'waiting'

export type DeskAttachment = {
  id: string
  kind: AttachmentKind
  filename: string
  mime: string
  sizeBytes: number
  status: AttachmentStatus
}

export type DeskReportRow = {
  code: string
  createdAt: number
  updatedAt: number
  source: ReportSource
  status: ReportStatus
  title?: string
  // The list sends the first 200 characters only; the detail sends all of it.
  what: string
  whereArea?: WhereArea
  device?: Device
  verdict?: Verdict
  // Not in the list answer: a row gets them from its detail answer (Desk patchRow).
  prUrl?: string
  duplicateOf?: string
  // The player's files (video or picture) that did not end as an aborted upload; their kind and size are not sent.
  fileCount: number
}

export type DeskListRes = {
  reports: DeskReportRow[]
  cursor?: string
  // The worker on main sends no counts: the filter pills then show no number.
  counts?: Partial<Record<DeskFilter, number>>
}

// GET /desk/reports: one row per report, newest first, 50 a page.
export type DeskListRowWire = {
  code: string
  created_at: number
  updated_at: number
  source: ReportSource
  status: ReportStatus
  verdict: Verdict | null
  title: string | null
  what: string
  where_area: WhereArea | null
  device: Device | null
  attachment_count: number
}
export type DeskListWire = { reports: DeskListRowWire[]; nextCursor: string | null }

// Every attachment of the report, frames included, in creation order. R2 keys and upload ids stay in the worker.
export type DeskAttachmentWire = {
  id: string
  kind: AttachmentKind
  filename: string
  mime: string
  size_bytes: number
  status: AttachmentStatus
  created_at: number
  completed_at: number | null
}

// GET /desk/reports/{code}: the report row minus its token and ip hashes, triage and game_context parsed (a stored
// text that is not JSON comes back as that text).
export type DeskReportWire = {
  report: {
    code: string
    created_at: number
    updated_at: number
    source: ReportSource
    status: ReportStatus
    title: string | null
    what: string
    where_area: WhereArea | null
    device: Device | null
    lang: string | null
    roblox_name: string | null
    roblox_user_id: number | null
    discord_name: string | null
    game_context: unknown
    verdict: Verdict | null
    triage: unknown
    duplicate_of: string | null
    pr_url: string | null
  }
  attachments: DeskAttachmentWire[]
  duplicates: string[]
}

// The agent's triage JSON (<= 32 KB) is free-form: the known fields are typed, anything else is kept as data.
export type DeskTriage = {
  summary?: string
  cause?: string
  riskPath?: string
  sameAs?: string[]
  fix?: string
  confidence?: number
  frameHits?: number[]
} & Record<string, unknown>

export type DeskReport = Omit<DeskReportRow, 'fileCount'> & {
  lang?: string
  robloxName?: string
  robloxUserId?: number
  discordName?: string
  gameContext?: Record<string, unknown>
  triage?: DeskTriage
  attachments: DeskAttachment[]
  frames: DeskAttachment[]
  // Codes of the reports linked to this one as duplicates.
  duplicates: string[]
}

// `duplicate` needs `duplicateOf`; any other status clears the link (the desk only sends `fixed` today).
export type DeskStatusBody = { status: ReportStatus; prUrl?: string; note?: string; duplicateOf?: string }
