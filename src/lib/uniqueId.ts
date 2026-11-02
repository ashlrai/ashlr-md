/**
 * uniqueId.ts — CSPRNG-backed identifier generation.
 *
 * The app generates a lot of one-off ids (memory items, conversation
 * sessions/messages, paste-image filename tokens, template ids, AI request
 * ids). They only need uniqueness, but they used `Math.random()`, which Sonar
 * S2245 flags as a pseudorandom generator in security-sensitive code — and
 * session/message ids do get echoed back over MCP, so unguessable ids are
 * genuinely preferable anyway. All of those call sites now funnel through
 * these helpers, which draw from `crypto.getRandomValues`.
 */

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * `length` uniformly-distributed base36 characters.
 *
 * `getRandomValues` bytes are 0–255; bytes ≥ 252 are rejected so the `b % 36`
 * map has no modulo bias (36 × 7 = 252). The buffer is over-filled 2× so a
 * single draw virtually always supplies enough acceptable bytes.
 */
export function randomBase36(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array((length - out.length) * 2));
    for (const b of bytes) {
      if (b < 252) {
        out.push(BASE36_ALPHABET[b % 36]);
        if (out.length === length) break;
      }
    }
  }
  return out.join("");
}

/**
 * `${prefix}${Date.now()}-${rand}` — time-prefixed so ids stay roughly
 * sortable, with a CSPRNG tail (`randLen` base36 chars) so same-millisecond
 * calls and stores rehydrated from localStorage cannot collide.
 */
export function uniqueId(prefix = "", randLen = 8): string {
  return `${prefix}${Date.now()}-${randomBase36(randLen)}`;
}
