// Cleaning and checking of untrusted fields (CONTRACT.md "Limits", and the enums of "D1 schema" and "Statuses").
import { HttpError } from "./http";

export const WHERE_AREAS = ["lobby", "match", "shop", "crates", "clan", "other"] as const;
export const DEVICES = ["phone", "tablet", "computer", "console"] as const;
export const STATUSES = ["received", "looking", "fixed", "duplicate", "not_bug", "closed"] as const;
export const VERDICTS = ["simple_fix", "needs_person", "duplicate", "not_bug", "unclear"] as const;
export type PublicStatus = "received" | "looking" | "fixed" | "checked";

// C0 and C1 control characters except tab and newline; \r goes too, so line ends have one shape.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export const cleanText = (value: string): string => value.replace(CONTROL, "").trim();

/**
 * The cleaned string, `min..max` characters counted as a reader does (code points, not UTF-16 units), or 400
 * `invalid_<field>`. With `min` 0 the field is optional: absent, null or empty after cleaning gives null.
 */
export function text(value: unknown, field: string, min: number, max: number): string | null {
  if ((value === undefined || value === null) && min === 0) return null;
  if (typeof value !== "string") throw new HttpError(400, `invalid_${field}`);
  const cleaned = cleanText(value);
  const len = [...cleaned].length;
  if (len === 0 && min === 0) return null;
  if (len < min || len > max) throw new HttpError(400, `invalid_${field}`);
  return cleaned;
}

/** One of `allowed`, null when absent, else 400 `invalid_<field>`. */
export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new HttpError(400, `invalid_${field}`);
}

export const what = (v: unknown): string => text(v, "what", 1, 2000)!;
export const title = (v: unknown): string | null => text(v, "title", 0, 200);
export const robloxName = (v: unknown): string | null => text(v, "roblox_name", 0, 20);

/** BCP 47 shape only (language, then subtags): a hint for the team, never used to choose a code path. */
export function lang(v: unknown): string | null {
  const s = text(v, "lang", 0, 10);
  if (s !== null && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(s)) throw new HttpError(400, "invalid_lang");
  return s;
}
