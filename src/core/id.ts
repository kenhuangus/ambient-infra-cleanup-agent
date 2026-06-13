/**
 * Deterministic id + hash utilities.
 *
 * Findings/recommendations need stable ids so the StateStore can dedup the
 * same candidate across runs. We use Node's built-in crypto only — no deps.
 *
 * OWNED BY: Wave 1 (Lead-approval required to change).
 */

import { createHash, randomUUID } from 'node:crypto';

/** SHA-256 hex digest of the given parts (joined with a unit separator). */
export function hash(...parts: Array<string | number>): string {
  const h = createHash('sha256');
  h.update(parts.map((p) => String(p)).join('\u001f'));
  return h.digest('hex');
}

/** Short (12-char) stable hash, handy for ids and branch names. */
export function shortHash(...parts: Array<string | number>): string {
  return hash(...parts).slice(0, 12);
}

/**
 * Deterministic id with a domain/kind prefix, e.g. `dbt:9f2a1c0b7d34`.
 * Stable across runs for the same inputs so findings dedup cleanly.
 */
export function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}:${shortHash(...parts)}`;
}

/** Random opaque id for ephemeral things (run ids, draft ids). */
export function randomId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}:${id}` : id;
}

/** Slugify text for safe use in branch names / labels. */
export function slug(text: string, maxLen = 50): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > maxLen ? s.slice(0, maxLen).replace(/-+$/g, '') : s;
}
