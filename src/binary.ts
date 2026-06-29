/**
 * Binary detection — shared by read/edit to avoid dumping non-text bytes
 * (images, compiled artifacts) into the model's context window.
 *
 * Heuristic: a NUL byte in the leading sample is a strong, well-established
 * signal that the buffer is not text. We only scan a prefix because scanning
 * a multi-megabyte file on every call is wasteful; a real text file won't
 * contain a NUL byte anywhere in that prefix.
 */

/** Max prefix length to scan for a NUL byte. */
const SAMPLE_SIZE = 8192;

/** True if the buffer looks like binary (contains a NUL byte in its prefix). */
export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SAMPLE_SIZE);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
