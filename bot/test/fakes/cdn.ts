// A fake `fetchImpl` for the Discord CDN: it serves known attachment URLs from memory and records each call.
// No network is ever touched; an unknown URL answers 404 like an expired CDN link.

/** Deterministic bytes, so a spec can check that what reached the worker is the file and not something else. */
export function patternBytes(size: number, seed = 7): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) % 251;
  return b;
}

export type FakeCdn = {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: string[];
};

export function fakeCdn(files: Record<string, Uint8Array>, failing: Set<string> = new Set()): FakeCdn {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (failing.has(url)) return new Response('gone', { status: 404 });
    const bytes = files[url];
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  };
  return { fetchImpl, calls };
}
