// Request and response shapes of CONTRACT.md "HTTP API (worker)". Public shapes follow the contract's tables.
// Desk shapes are not detailed in the contract: they are the web slice's reading of the D1 schema (camelCase, as
// the rest of the API), to be aligned with the worker.

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

// What the list needs to say "Video 312 MB · Phone" or "No video" without loading every attachment.
export type DeskAttachmentSummary = { videos: number; images: number; totalBytes: number }

export type DeskReportRow = {
  code: string
  createdAt: number
  updatedAt: number
  source: ReportSource
  status: ReportStatus
  title?: string
  what: string
  whereArea?: WhereArea
  device?: Device
  verdict?: Verdict
  prUrl?: string
  duplicateOf?: string
  attachments: DeskAttachmentSummary
}

export type DeskListRes = {
  reports: DeskReportRow[]
  cursor?: string
  counts?: Partial<Record<DeskFilter, number>>
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

export type DeskReport = Omit<DeskReportRow, 'attachments'> & {
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

export type DeskStatusBody = { status: ReportStatus; prUrl?: string; note?: string }
