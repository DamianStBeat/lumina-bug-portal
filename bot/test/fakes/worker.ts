// A fake of the portal worker (CONTRACT.md "HTTP API"), served by a real node:http server on 127.0.0.1, port 0.
// It checks the auth headers the contract asks for, so a request with the wrong header fails here as it would
// on Cloudflare, and it records every request so the specs assert what reached the worker, never internals.
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

export type FakeEvent = { seq: number; code: string; at: number; type: string; data: unknown };

export class FakeWorker {
  readonly requests: RecordedRequest[] = [];
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

  private constructor() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  static async start(): Promise<FakeWorker> {
    const w = new FakeWorker();
    await new Promise<void>((resolve) => w.server.listen(0, '127.0.0.1', resolve));
    w.port = (w.server.address() as AddressInfo).port;
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
      return {
        status: 201,
        body: { attachmentId: `att-${this.attachmentSeq}`, partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) },
      };
    }
    if (r.method === 'PUT' && (m = r.path.match(/^\/attachments\/([\w-]+)\/parts\/(\d+)$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      return { status: 200, body: { n: Number(m[2]), etag: `etag-${m[1]}-${m[2]}` } };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/attachments\/([\w-]+)\/complete$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
      return { status: 200, body: { ok: true } };
    }
    if (r.method === 'DELETE' && (m = r.path.match(/^\/attachments\/([\w-]+)$/))) {
      if (!tokenOk) return { status: 401, body: { error: 'unauthorized' } };
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
