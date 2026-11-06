// The `context` a Lumina2 server sends with a game report (CONTRACT.md "Game"): only the listed keys, each with its
// expected type, small enough to store (<= 16 KB serialized).
import { HttpError } from "./http";
import { cleanText, DEVICES } from "./validate";

const MAX_BYTES = 16 * 1024;
const MAX_STRING = 100;
const MAX_ERROR_CHARS = 300;
const MAX_ERRORS = 50;

const NUMBERS = ["placeId", "placeVersion", "wave", "fps", "pingMs", "at"] as const;
const STRINGS = ["jobId", "map", "mode", "platform"] as const;

/** Cleaned like every other text field, then cut to `max` code points (a surrogate pair is never split). */
const cut = (s: string, max: number): string => [...cleanText(s)].slice(0, max).join("");

const byteSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The context as the JSON text to store, or null when the server sent none. A context that is not an object is a
 * client bug (400 `invalid_context`); inside it, a key of the wrong type is dropped rather than refused, so one bad
 * field never costs the player the report. Error lines: the first 50, each cut to 300 characters, and if the whole
 * is still over 16 KB (long non-Latin lines) the last ones go until it fits.
 */
export function gameContext(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_context");
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of NUMBERS) {
    const n = input[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  for (const key of STRINGS) {
    const s = input[key];
    if (typeof s === "string") out[key] = cut(s, MAX_STRING);
  }
  if ((DEVICES as readonly unknown[]).includes(input.device)) out.device = input.device;
  if (Array.isArray(input.errors)) {
    const errors = input.errors
      .filter((e): e is string => typeof e === "string")
      .slice(0, MAX_ERRORS)
      .map((e) => cut(e, MAX_ERROR_CHARS));
    out.errors = errors;
    while (errors.length > 0 && byteSize(out) > MAX_BYTES) errors.pop();
  }
  return JSON.stringify(out);
}
