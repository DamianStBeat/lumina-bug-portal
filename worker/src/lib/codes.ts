// Report codes (LUM- + 6 random digits) and ulid ids.

/** Source for route patterns: `new RegExp(`^/reports/(${CODE_PATTERN})$`)`. */
export const CODE_PATTERN = "LUM-\\d{6}";

/** Rejection sampling keeps the six digits uniform (a plain `% 1e6` favours the low codes slightly). */
export function newCode(): string {
  const limit = Math.floor(2 ** 32 / 1e6) * 1e6;
  let n: number;
  do n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  while (n >= limit);
  return `LUM-${String(n % 1e6).padStart(6, "0")}`;
}

/** Runs `insert` with fresh codes until one misses the UNIQUE index on reports.code; any other error is rethrown. */
export async function withNewCode<T>(insert: (code: string) => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await insert(newCode());
    } catch (err) {
      const taken = err instanceof Error && err.message.includes("UNIQUE constraint failed: reports.code");
      if (!taken || i >= attempts) throw err;
    }
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48-bit ms time + 80 random bits in Crockford base32 (26 characters): ids sort by creation. */
export function ulid(now = Date.now()): string {
  let out = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) out = CROCKFORD[t % 32] + out;
  for (const b of crypto.getRandomValues(new Uint8Array(16))) out += CROCKFORD[b % 32];
  return out;
}
