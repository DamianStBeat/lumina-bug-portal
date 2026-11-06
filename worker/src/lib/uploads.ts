// Checks for the fields of a new attachment (CONTRACT.md "Limits") and the multipart sizes every upload route shares.
import { HttpError } from "./http";

export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** Player files per report; frames (written by the agent) never count. */
export const MAX_PLAYER_FILES = 3;

/** `video/<subtype>` or `image/<subtype>`, subtype an RFC 6838 token; parameters such as `; codecs=` are refused. */
const MIME = /^(video|image)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The mime lower-cased and its kind, or 400 `invalid_mime`. The declared type is only a hint: the agent re-checks. */
export function parseMime(value: unknown): { mime: string; kind: "video" | "image" } {
  const mime = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = MIME.exec(mime);
  if (!match) throw new HttpError(400, "invalid_mime");
  return { mime, kind: match[1] as "video" | "image" };
}

/** A whole number of bytes, 1..2 GiB: 400 `invalid_size` for anything that is not a positive integer. */
export function parseSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "invalid_size");
  if (value > MAX_FILE_BYTES) throw new HttpError(400, "file_too_large");
  return value;
}

// Kept: letters and digits of any script, space, dot, dash, underscore, brackets. Everything else (controls, bidi
// marks, quotes, slashes, shell and HTML characters) becomes "_", so the name is safe in a header or a page later.
const UNSAFE = /[^\p{L}\p{N} ._()-]/gu;

/** The name the desk shows: last path part only, unsafe characters replaced, at most 120 characters, never empty. */
export function sanitizeFilename(value: unknown): string {
  const raw = typeof value === "string" ? value.normalize("NFC") : "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  // Leading dots and spaces go so the result is never ".", ".." or a hidden-file name.
  const cleaned = base.replace(UNSAFE, "_").replace(/^[. ]+/, "").trimEnd();
  const cut = [...cleaned].slice(0, 120).join("").trimEnd();
  return cut === "" ? "file" : cut;
}

/** Bytes part `n` (1-based) must hold: a full part, or what is left for the last one. */
export function expectedPartSize(n: number, partCount: number, size: number): number {
  return n < partCount ? PART_SIZE : size - (partCount - 1) * PART_SIZE;
}

/** R2's "no such multipart upload" (code 10024): the upload was already completed or aborted. */
export function isNoSuchUpload(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("10024") || message.includes("multipart upload does not exist");
}
