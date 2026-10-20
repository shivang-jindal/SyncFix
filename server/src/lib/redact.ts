/**
 * Redaction helpers (Part D / D9: "Avoid storing unnecessary full source
 * payloads; redact sensitive fields and configure retention").
 *
 * A default deny-list of sensitive key names is always applied. An organization
 * can extend it through its settings. Values are replaced with a fixed marker -
 * the original is never stored anywhere.
 */

const DEFAULT_REDACTED_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'private_key',
  'client_secret',
  'session',
  'cookie',
  'signature',
  'signing_secret',
  'ssn',
  'social_security_number',
  'card_number',
  'cvv',
  'iban',
  'account_number',
  'tax_id',
];

/** Deepest nesting walked before a payload is truncated. */
const MAX_DEPTH = 6;
/** Hard cap on array elements kept per level. */
const MAX_ARRAY_ITEMS = 50;
/** Hard cap on the number of keys kept at the top level. */
const MAX_KEYS = 200;
/** Hard cap on any single string value. */
const MAX_STRING = 2_000;

export const REDACTED = '[redacted]';

export interface RedactOptions {
  extraKeys?: string[];
  maxKeys?: number;
}

export function redactPayload(
  value: unknown,
  options: RedactOptions = {},
  depth = 0,
): unknown {
  const keys = new Set([...DEFAULT_REDACTED_KEYS, ...(options.extraKeys ?? []).map((k) => k.toLowerCase())]);
  const maxKeys = options.maxKeys ?? MAX_KEYS;

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[truncated: max depth]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => redactPayload(entry, options, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    let index = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (index >= maxKeys) {
        output.__truncated = 'additional fields omitted';
        break;
      }
      if (keys.has(key.toLowerCase())) {
        output[key] = REDACTED;
      } else {
        const redacted = redactPayload(entry, options, depth + 1);
        if (redacted !== undefined) output[key] = redacted;
      }
      index += 1;
    }
    return output;
  }

  return undefined;
}

export function redactPayloadObject(
  value: Record<string, unknown> | null | undefined,
  options: RedactOptions = {},
): Record<string, unknown> | null {
  if (!value) return null;
  return (redactPayload(value, options) as Record<string, unknown>) ?? null;
}

/**
 * A minimal, deterministic field diff for the issue detail view. Only the
 * changed keys are listed, values are redacted and truncated.
 */
export function payloadDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  options: RedactOptions = {},
): Array<{ path: string; before: unknown; after: unknown }> {
  const left = (before ? redactPayload(before, options) : {}) as Record<string, unknown>;
  const right = (after ? redactPayload(after, options) : {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const diff: Array<{ path: string; before: unknown; after: unknown }> = [];

  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      diff.push({ path: key, before: a ?? null, after: b ?? null });
    }
    if (diff.length >= 100) break;
  }
  return diff;
}

/** Collects every top-level field name present in a payload. */
export function collectFieldNames(value: Record<string, unknown>, depth = 0): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown, prefix: string, level: number) => {
    if (level > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node.slice(0, MAX_ARRAY_ITEMS)) walk(entry, prefix, level + 1);
      return;
    }
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      names.add(path);
      if (entry && typeof entry === 'object') walk(entry, path, level + 1);
    }
  };
  walk(value, '', depth);
  return names;
}

/** Strips a URL query string, which can contain API keys. */
export function safeUrlLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}