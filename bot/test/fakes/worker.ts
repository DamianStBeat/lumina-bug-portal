// A fake of the portal API (CONTRACT.md "HTTP API" and "Supabase deployment"), served by a real node:http server on
// 127.0.0.1, port 0. It checks the auth headers the contract asks for, so a request with the wrong header fails here as
// it would on the function, and it records every request so the specs assert what reached the API, never internals.
// FakeStorage is a second server, so a signed URL is another origin as on Supabase: whatever the client sends there
// is recorded apart from the API's requests.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const AGENT_KEY = 'test-agent-key-not-real';
export const REPORT_TOKEN = 'test-report-token-not-real';
export const PART_SIZE = 16 * 1024 * 1024;

export type RecordedRequest = {
  method: string;
  path: string; // without the /api/v1 prefix and without the query
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: unknown; // parsed body when it was JSON, else undefined
};

export type Reply = { status: number; body?: unknown; raw?: string };

// ok: answer as the contract says. error: every call answers 503 {error:"unavailable"}.
// hang: never answer (the client's timeout must fire). close: drop the socket without an answer.
export type WorkerMode = 'ok' | 'error' | 'hang' | 'close';

// `code` is null for an event whose report retention removed (the worker keeps its place in the sequence).
// status_changed data is `{ from, to, note?, prUrl? }`, as worker/src/routes/agent.ts and desk.ts write it.
export type FakeEvent = { seq: number; code: string | null; at: number; type: string; data: unknown };

// ---------------------------------------------------------------- the private bucket, behind signed URLs
export type StorageRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Parsed from the object path; undefined when the path is not a part of the bucket. */
  attachment: string | undefined;
  part: number | undefined;
  token: string | null;
};

type StorageOverride = (req: StorageRequest) => Reply | 'hang' | 'close' | undefined;

const SIGNED_UPLOAD_PATH = /^\/storage\/v1\/object\/upload\/sign\/bug-portal\/([\w-]+)\/part-(\d{5})$/;

export class FakeStorage {
  readonly requests: StorageRequest[] = [];
  /** Per-request override: a Reply answers it, 'hang' never answers, 'close' drops the socket. */
  override: StorageOverride | undefined;
  /** The status a dead URL answers (403 unless a spec asks for another refusal). */
  deadStatus = 403;
  /** Objects stored, `<attachmentId>/<n>`. */
  readonly objects = new Map<string, Buffer>();

  private readonly tokens = new Map<string, { attachment: string; part: number; dead: boolean }>();
  private readonly dieNext = new Map<number, number>();
  private tokenSeq = 0;
  private port = 0;
  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.override = undefined;
    this.deadStatus = 403;
    this.objects.clear();
    this.tokens.clear();
    this.dieNext.clear();
  }

  /** The next `times` URLs signed for part `n` are dead from birth: they answer `deadStatus` however often they are tried. */
  killNextUrls(n: number, times = 1): void {
    this.dieNext.set(n, (this.dieNext.get(n) ?? 0) + times);
  }

  /** What the function does for POST .../upload-url: a fresh URL on another origin, with its own token. */
  signUpload(attachment: string, part: number): string {
    this.tokenSeq += 1;
    const token = `signed-token-${this.tokenSeq}`;
    const left = this.dieNext.get(part) ?? 0;
    if (left > 0) this.dieNext.set(part, left - 1);
    this.tokens.set(token, { attachment, part, dead: left > 0 });
    const object = `${attachment}/part-${String(part).padStart(5, '0')}`;
    return `http://127.0.0.1:${this.port}/storage/v1/object/upload/sign/bug-portal/${object}?token=${token}`;
  }

  /** PUTs that carried bytes to the bucket, in arrival order, refused ones included. */
  puts(): StorageRequest[] {
    return this.requests.filter((r) => r.method === 'PUT');
  }

  /** The bytes of the file as the bucket holds them, parts joined by ascending n. */
  joined(attachment: string, partCount: number): Buffer {
    const parts: Buffer[] = [];
    for (let n = 1; n <= partCount; n++) parts.push(this.objects.get(`${attachment}/${n}`) ?? Buffer.alloc(0));
    return Buffer.concat(parts);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const m = url.pathname.match(SIGNED_UPLOAD_PATH);
      const rec: StorageRequest = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
        attachment: m?.[1],
        part: m ? Number(m[2]) : undefined,
        token: url.searchParams.get('token'),
      };
      this.requests.push(rec);
      const forced = this.override?.(rec);
      if (forced === 'hang') return;
      if (forced === 'close') {
        req.socket.destroy();
        return;
      }
      const reply = forced ?? this.answer(rec);
      res.writeHead(reply.status, { 'content-type': reply.raw !== undefined ? 'text/plain' : 'application/json' });
      res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
    });
  }

  private answer(r: StorageRequest): Reply {
    const signed = r.token === null ? undefined : this.tokens.get(r.token);
    if (signed === undefined || signed.attachment !== r.attachment || signed.part !== r.part) {
      return { status: 400, body: { statusCode: '400', error: 'InvalidToken', message: 'invalid signature' } };
    }
    if (signed.dead) return { status: this.deadStatus, body: { statusCode: String(this.deadStatus), error: 'Unauthorized', message: 'jwt expired' } };
    if (r.method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } };
    // The bucket's allowed types (CONTRACT.md "Storage"): what a part is sent as.
    if (r.headers['content-type'] !== 'application/octet-stream') return { status: 415, body: { error: 'invalid_mime_type' } };
    if (r.body.length > PART_SIZE) return { status: 413, body: { error: 'too_large' } };
    this.objects.set(`${signed.attachment}/${signed.part}`, r.body);
    return { status: 200, body: { Key: r.path } };
  }
}

type UploadState = { size: number; partCount: number; status: 'uploading' | 'complete' | 'aborted' };

export class FakeWorker {
  readonly requests: RecordedRequest[] = [];
  /** The bucket behind the signed URLs this API hands out. */
  readonly storage = new FakeStorage();
  mode: WorkerMode = 'ok';
  /** Rows served by GET /agent/reports/{code}, keyed by code (snake_case, as the D1 row). */
  readonly reports = new Map<string, Record<string, unknown>>();
  readonly events: FakeEvent[] = [];
  /** Code handed out by POST /agent/reports. */
  nextCode = 'LUM-482193';
  /** Per-request override: return a Reply to answer it, or undefined to fall through to the default route. */
  override: ((req: RecordedRequest) => Reply | 'hang' | 'close' | undefined) | undefined;

  private server: http.Server;
  private port = 0;
  private attachmentSeq = 0;
  private readonly uploads = new Map<string, UploadState>();

  private constructor() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  static async start(): Promise<FakeWorker> {
    const w = new FakeWorker();
    await new Promise<void>((resolve) => w.server.listen(0, '127.0.0.1', resolve));
    w.port = (w.server.address() as AddressInfo).port;
    await w.storage.start();
    return w;
  }

  /** The API base the bot is configured with (CONTRACT.md: base `/api/v1`). */
  get base(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  async stop(): Promise<void> {
    // Hanging requests keep their sockets open: close them so the test process can exit.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.storage.stop();
  }

  /** Requests matching a method and a path (string = exact, RegExp = test). */
  find(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)),
    );
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks);
      let json: unknown;
      if ((req.headers['content-type'] ?? '').includes('json') && body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          json = undefined;
        }
      }
      const rec: RecordedRequest = {
        method: req.method ?? '',
        path: url.pathname.startsWith('/api/v1') ? url.pathname.slice('/api/v1'.length) : url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json,
      };
      this.requests.push(rec);

      const forced = this.override?.(rec);
      const mode: WorkerMode = forced === 'hang' || forced === 'close' ? forced : this.mode;
      if (mode === 'hang') return; // never answered; closeAllConnections() ends it at stop()
      if (mode === 'close') {
        req.socket.destroy();
        return;
      }
      let reply: Reply;
      if (forced && typeof forced === 'object') reply = forced;
      else if (mode === 'error') reply = { status: 503, body: { error: 'unavailable' } };
      else if (!url.pathname.startsWith('/api/v1/')) reply = { status: 404, body: { error: 'not_found' } };
      else reply = this.route(rec);

      const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
      res.writeHead(reply.status, { 'content-type': reply.raw !== undefined ? 'text/plain' : 'application/json' });
      res.end(text);
    });
  }

  private route(r: RecordedRequest): Reply {
    const agentOk = r.headers['authorization'] === `Bearer ${AGENT_KEY}`;
    const tokenOk = r.headers['x-report-token'] === REPORT_TOKEN;
    let m: RegExpMatchArray | null;

    if (r.path.startsWith('/agent/')) {
      if (!agentOk) return { status: 401, body: { error: 'unauthorized' } };
      if (r.method === 'POST' && r.path === '/agent/reports') {
        const refused = refuseDiscordReport(r.json);
        if (refused) return refused;
        return { status: 201, body: { code: this.nextCode, reportToken: REPORT_TOKEN } };
      }
      if (r.method === 'POST' && (m = r.path.match(/^\/agent\/reports\/(LUM-\d{6})\/discord$/))) {
        const row = this.reports.get(m[1]!);
        const threadId = (r.json as { threadId?: unknown } | undefined)?.threadId;
        if (!isSnowflake(threadId)) return { status: 400, body: { error: 'invalid_thread_id' } };
        if (row && typeof threadId === 'string') row['discord_thread_id'] = threadId;
        return { status: 200, body: { ok: true } };
      }
      if (r.method === 'GET' && (m = r.path.match(/^\/agent\/reports\/(LUM-\d{6})$/))) {
        const row = this.reports.get(m[1]!);
        return row ? { status: 200, body: row } : { status: 404, body: { error: 'not_found' } };
      }
      if (r.method === 'GET' && r.path === '/agent/events') {
        const after = Number(r.query.get('after') ?? '0');
        const limit = Number(r.query.get('limit') ?? '50');
        const page = this.events.filter((e) => e.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
        const last = page.length > 0 ? page[page.length - 1]!.seq : after;
        return { status: 200, body: { events: page, last } };
      }
      return { status: 404, body: { error: 'not_found' } };
    }

    if (r.method === 'POST' && (m = r.path.match(/^\/reports\/(LUM-\d{6})\/attachments$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      const size = Number((r.json as { size?: unknown } | undefined)?.size);
      if (!Number.isFinite(size) || size <= 0) return { status: 400, body: { error: 'bad_size' } };
      this.attachmentSeq += 1;
      const partCount = Math.ceil(size / PART_SIZE);
      this.uploads.set(`att-${this.attachmentSeq}`, { size, partCount, status: 'uploading' });
      return { status: 201, body: { attachmentId: `att-${this.attachmentSeq}`, partSize: PART_SIZE, partCount } };
    }
    // CONTRACT.md "Upload routes": `PUT /attachments/{id}/parts/{n}` no longer exists, so it falls through to the 404.
    if (r.method === 'POST' && (m = r.path.match(/^\/attachments\/([\w-]+)\/parts\/(\d+)\/upload-url$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      const up = this.uploads.get(m[1]!);
      if (!up) return { status: 404, body: { error: 'not_found' } };
      if (up.status !== 'uploading') return { status: 409, body: { error: 'not_uploading' } };
      const n = Number(m[2]);
      if (n < 1 || n > up.partCount) return { status: 400, body: { error: 'invalid_part' } };
      return { status: 200, body: { n, url: this.storage.signUpload(m[1]!, n), expiresIn: 7200 } };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/attachments\/([\w-]+)\/complete$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      const up = this.uploads.get(m[1]!);
      if (!up) return { status: 404, body: { error: 'not_found' } };
      // As the function: a part missing from the bucket or of the wrong size counts as missing.
      const missing: number[] = [];
      for (let n = 1; n <= up.partCount; n++) {
        const want = n < up.partCount ? PART_SIZE : up.size - PART_SIZE * (up.partCount - 1);
        if (this.storage.objects.get(`${m[1]!}/${n}`)?.length !== want) missing.push(n);
      }
      if (missing.length > 0) return { status: 409, body: { error: 'missing_parts', missing } };
      up.status = 'complete';
      return { status: 200, body: { ok: true } };
    }
    if (r.method === 'DELETE' && (m = r.path.match(/^\/attachments\/([\w-]+)$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      const up = this.uploads.get(m[1]!);
      if (up) up.status = 'aborted';
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }
}

// ---------------------------------------------------------------- validation, as the real worker does it
// A copy of worker/src/lib/validate.ts and createDiscord/setThread in worker/src/routes/agent.ts (worker slice,
// 6 Nov 2026). The real module cannot be imported here (another package, extensionless imports), so the rules are
// mirrored one by one; a fake looser than the worker let `where: "Match"` pass a spec while production refused it.

export const WHERE_AREAS = ['lobby', 'match', 'shop', 'crates', 'clan', 'other'] as const;
// C0 and C1 control characters except tab and newline, as the worker's cleanText.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const SNOWFLAKE = /^\d{1,20}$/;

function isSnowflake(v: unknown): boolean {
  return typeof v === 'string' && SNOWFLAKE.test(v);
}

/** true when the field passes v.text(value, field, min, max): code points after cleaning, optional when min is 0. */
function textOk(value: unknown, min: number, max: number): boolean {
  if ((value === undefined || value === null) && min === 0) return true;
  if (typeof value !== 'string') return false;
  const len = [...value.replace(CONTROL, '').trim()].length;
  if (len === 0 && min === 0) return true;
  return len >= min && len <= max;
}

function refuse(field: string): Reply {
  return { status: 400, body: { error: `invalid_${field}` } };
}

/** The 400 the worker answers to POST /agent/reports, or undefined when it would accept the body. */
function refuseDiscordReport(json: unknown): Reply | undefined {
  const b = (json ?? {}) as Record<string, unknown>;
  if (b['source'] !== 'discord') return refuse('source');
  if (!isSnowflake(b['discordUserId'])) return refuse('discord_user_id');
  if (!textOk(b['discordName'], 1, 100)) return refuse('discord_name');
  if (b['threadId'] !== undefined && b['threadId'] !== null && !isSnowflake(b['threadId'])) return refuse('thread_id');
  if (!textOk(b['what'], 1, 2000)) return refuse('what');
  if (!textOk(b['title'], 0, 200)) return refuse('title');
  const where = b['where'];
  if (where !== undefined && where !== null && !(typeof where === 'string' && (WHERE_AREAS as readonly string[]).includes(where))) {
    return refuse('where');
  }
  return undefined;
}

/** An API base where nothing listens: a server is opened on port 0 and closed, so connecting is refused. */
export async function deadBase(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/v1`;
}
