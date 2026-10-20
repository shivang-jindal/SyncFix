import { describe, it, expect } from 'vitest';
import { stableHash, hashText, canonicalize } from './stable-hash.js';

describe('Stable Hash', () => {
  it('should produce consistent hashes for the same input', () => {
    const input = { a: 1, b: 2, c: { d: 3 } };
    const hash1 = stableHash(input);
    const hash2 = stableHash(input);
    expect(hash1).toBe(hash2);
  });

  it('should produce same hash regardless of key order', () => {
    const input1 = { a: 1, b: 2 };
    const input2 = { b: 2, a: 1 };
    expect(stableHash(input1)).toBe(stableHash(input2));
  });

  it('should handle nested objects', () => {
    const input = { a: { b: { c: 1 } } };
    const hash = stableHash(input);
    expect(hash).toHaveLength(64); // SHA-256 hex length
  });

  it('should handle arrays', () => {
    const input = [1, 2, { a: 3 }];
    const hash = stableHash(input);
    expect(hash).toHaveLength(64);
  });

  it('should handle null and undefined', () => {
    expect(stableHash(null)).toBe(stableHash(null));
    expect(stableHash(undefined)).toBe(stableHash(undefined));
  });

  it('hashText should produce consistent hashes', () => {
    const text = 'hello world';
    const hash1 = hashText(text);
    const hash2 = hashText(text);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('canonicalize should sort object keys', () => {
    const input = { z: 1, a: 2 };
    const canonical = canonicalize(input);
    const keys = Object.keys(canonical as object);
    expect(keys).toEqual(['a', 'z']);
  });

  it('canonicalize should handle dates', () => {
    const date = new Date('2026-01-15T09:12:00.000Z');
    const input = { date };
    const canonical = canonicalize(input);
    expect(canonical).toEqual({ date: '2026-01-15T09:12:00.000Z' });
  });
});