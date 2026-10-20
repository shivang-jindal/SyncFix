/**
 * Deterministic hashing for change detection.
 *
 * Keys are sorted at every level so `{a,b}` and `{b,a}` hash identically, which
 * is what makes "has this record changed?" a stable question. The output is a
 * hex SHA-256 of the canonical JSON form.
 */

import { createHash as nodeCreateHash } from 'node:crypto';

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      output[key] = canonicalize(source[key]);
    }
    return output;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

/** Stable, key-order-independent SHA-256 of any JSON-compatible value. */
export function stableHash(value: unknown): string {
  return nodeCreateHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/** SHA-256 hex of a raw string. Used for webhook payload hashes. */
export function hashText(value: string): string {
  return nodeCreateHash('sha256').update(value, 'utf8').digest('hex');
}