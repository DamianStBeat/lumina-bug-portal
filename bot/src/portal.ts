// Client for the portal worker (CONTRACT.md "HTTP API"). Every failure becomes a PortalError with a short code, so
// a handler can tell "worker down" (timeout, network) from a refusal (the worker's own `error` field) and the logs
// carry the code only, never a header, token or body.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PortalError extends Error {
  override name = 'PortalError';
  readonly status: number | undefined;
  readonly code: string;

  constructor(code: string, status?: number) {
    super(status === undefined ? `portal ${code}` : `portal ${code} (${status})`);
    this.code = code;
    this.status = status;
  }
}

/** A short, secret-free tag for logs: the PortalError code, else the error's name. */
export function errorTag(err: unknown): string {
  if (err instanceof PortalError) return err.status === undefined ? err.code : `${err.code}:${err.status}`;
  return err instanceof Error ? err.name : 'unknown';
}

export type PublicStatus = 'received' | 'looking' | 'fixed' | 'checked';

/** CONTRACT.md "Statuses"; `duplicate` needs the original's row, so it is resolved by the caller. */
export function toPublicStatus(status: unknown): PublicStatus | undefined {
  switch (status) {
    case 'received':
    case 'looking':
    case 'fixed':
      return status;
    case 'not_bug':
    case 'closed':
      return 'checked';
    default:
      return undefined;
  }
}

/** The D1 row as GET /agent/reports/{code} returns it (snake_case); only the columns the bot reads are named. */
export type ReportRow = {
  code: string;
  source?: string;
  status: string;
  /** Unix ms (CONTRACT.md), not checked by getReport: whoever reads it checks it is a number. */
  created_at?: unknown;
  title?: string | null;
  what?: string | null;
  discord_thread_id?: string | null;
  discord_name?: string | null;
  duplicate_of?: string | null;
  game_context?: unknown;
  [column: string]: unknown;
};

/** `code` is null when retention removed the report: the worker keeps the event's place in the sequence. */
export type PortalEvent = { seq: number; code: string | null; at: number; type: string; data: Record<string, unknown> };

/** CONTRACT.md `where_area`: the worker refuses any other value with 400 invalid_where. */
export type WhereArea = 'lobby' | 'match' | 'shop' | 'crates' | 'clan' | 'other';

export type NewDiscordReport = {
  discordUserId: string;
  discordName: string;
  threadId?: string;
  what: string;
  title?: string;
  where?: WhereArea;
};

/**
 * `size` is declared to the worker before any byte is sent; `body` is the bytes in memory or a stream of them (a
 * Discord download), and must carry exactly `size` bytes or the upload is aborted.
 */
export type UploadFile = { filename: string; mime: string; size: number; body: Uint8Array | AsyncIterable<Uint8Array> };

type Auth = { kind: 'agent' } | { kind: 'report'; token: string };
type CallOptions = { json?: unknown; bytes?: Uint8Array; auth: Auth };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function normaliseData(data: unknown): Record<string, unknown> {
  if (isObject(data)) return data;
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export class PortalApi {
  private readonly base: string;
  private readonly agentKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: { base: string; agentKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
    this.base = opts.base.replace(/\/+$/, '');
    this.agentKey = opts.agentKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async createDiscordReport(r: NewDiscordReport): Promise<{ code: string; reportToken: string }> {
    const body = await this.call('POST', '/agent/reports', { json: { source: 'discord', ...r }, auth: { kind: 'agent' } });
    if (!isObject(body) || typeof body['code'] !== 'string' || typeof body['reportToken'] !== 'string') {
      throw new PortalError('bad_response');
    }
    return { code: body['code'], reportToken: body['reportToken'] };
  }

  async linkThread(code: string, threadId: string): Promise<void> {
    await this.call('POST', `/agent/reports/${enc(code)}/discord`, { json: { threadId }, auth: { kind: 'agent' } });
  }

  async getReport(code: string): Promise<ReportRow> {
    const body = await this.call('GET', `/agent/reports/${enc(code)}`, { auth: { kind: 'agent' } });
    // CONTRACT.md says "the full report row + attachments" without pinning the shape: a flat row and
    // `{ report, attachments }` are both read (the agent slice accepts both too).
    const row = isObject(body) && isObject(body['report']) ? body['report'] : body;
    // Without a string status the bot would have to guess one, and a player must never read a status the worker
    // did not send (fix round 3, decision 20).
    if (!isObject(row) || typeof row['code'] !== 'string' || typeof row['status'] !== 'string') {
      throw new PortalError('bad_response');
    }
    return row as ReportRow;
  }

  async getEvents(after: number, limit = 50): Promise<{ events: PortalEvent[]; last: number }> {
    const q = new URLSearchParams({ after: String(after), limit: String(limit) });
    const body = await this.call('GET', `/agent/events?${q}`, { auth: { kind: 'agent' } });
    if (!isObject(body) || !Array.isArray(body['events'])) throw new PortalError('bad_response');
    const events: PortalEvent[] = [];
    for (const e of body['events']) {
      // A null code (report removed by retention) is a real event to step over, not a broken page.
      if (!isObject(e) || !Number.isInteger(e['seq']) || typeof e['type'] !== 'string') throw new PortalError('bad_response');
      if (e['code'] !== null && typeof e['code'] !== 'string') throw new PortalError('bad_response');
      events.push({
        seq: e['seq'] as number,
        code: e['code'] as string | null,
        at: typeof e['at'] === 'number' ? e['at'] : 0,
        type: e['type'],
        data: normaliseData(e['data']),
      });
    }
    const last = typeof body['last'] === 'number' ? body['last'] : Math.max(after, ...events.map((e) => e.seq));
    return { events, last };
  }

  /** CONTRACT.md multipart flow: create, every part, complete; any failure after the create aborts the upload. */
  async uploadAttachment(code: string, reportToken: string, file: UploadFile): Promise<void> {
    const auth: Auth = { kind: 'report', token: reportToken };
    const created = await this.call('POST', `/reports/${enc(code)}/attachments`, {
      json: { filename: file.filename, size: file.size, mime: file.mime },
      auth,
    });
    if (!isObject(created) || typeof created['attachmentId'] !== 'string') throw new PortalError('bad_response');
    const id = enc(created['attachmentId']);
    try {
      const { partSize, partCount } = created;
      // A part plan that does not cover the bytes exactly would complete a truncated or padded file.
      if (!isPositiveInt(partSize) || !isPositiveInt(partCount) || partCount !== Math.ceil(file.size / partSize)) {
        throw new PortalError('bad_response');
      }
      // One part buffer, filled as the bytes arrive: a 2 GiB video never sits in memory (the service has 300 MB).
      const part = new Uint8Array(Math.min(partSize, file.size));
      let filled = 0;
      let sent = 0;
      let received = 0;
      const chunks: AsyncIterable<Uint8Array> | Uint8Array[] = file.body instanceof Uint8Array ? [file.body] : file.body;
      for await (const chunk of chunks) {
        received += chunk.byteLength;
        if (received > file.size) throw new PortalError('size_mismatch');
        for (let off = 0; off < chunk.byteLength; ) {
          const take = Math.min(part.byteLength - filled, chunk.byteLength - off);
          part.set(chunk.subarray(off, off + take), filled);
          filled += take;
          off += take;
          if (filled === part.byteLength) {
            sent += 1;
            await this.call('PUT', `/attachments/${id}/parts/${sent}`, { bytes: part, auth });
            filled = 0;
          }
        }
      }
      if (filled > 0) {
        sent += 1;
        await this.call('PUT', `/attachments/${id}/parts/${sent}`, { bytes: part.subarray(0, filled), auth });
      }
      // Fewer bytes than declared would complete a truncated file.
      if (received !== file.size || sent !== partCount) throw new PortalError('size_mismatch');
      await this.call('POST', `/attachments/${id}/complete`, { auth });
    } catch (err) {
      // Best effort: a dangling upload is also aborted by the worker's retention cron after 7 days.
      await this.call('DELETE', `/attachments/${id}`, { auth }).catch(() => undefined);
      throw err;
    }
  }

  private async call(method: string, path: string, opts: CallOptions): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.auth.kind === 'agent') headers['authorization'] = `Bearer ${this.agentKey}`;
    else headers['x-report-token'] = opts.auth.token;
    let body: RequestInit['body'];
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = opts.bytes as Uint8Array<ArrayBuffer>;
    }

    let res: Response;
    let text: string;
    try {
      // One signal covers the headers and the body, so a worker that stalls mid-answer also times out.
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new PortalError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }

    const NOT_JSON = Symbol();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = NOT_JSON;
    }
    if (!res.ok) {
      const error = isObject(parsed) ? parsed['error'] : undefined;
      // The code ends up in logs: only the contract's snake_case shape is taken from the worker.
      const code = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : 'http_error';
      throw new PortalError(code, res.status);
    }
    // Callers that need fields check the shape; an empty 2xx is only fine where nothing is read.
    if (parsed === NOT_JSON) throw new PortalError('bad_response', res.status);
    return parsed;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
