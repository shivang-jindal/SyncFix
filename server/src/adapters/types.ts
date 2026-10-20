/**
 * Connector contract (Part D / D8).
 *
 * An adapter is "supported" only when every method it advertises is actually
 * implemented and covered by tests. An adapter that cannot perform a safe
 * operation throws `UnsupportedOperationError` rather than pretending to
 * succeed, and `capabilities.supportsWrite` is false so the engine never offers
 * the action in the UI.
 */

import type { ProviderKind } from '@syncfix/shared';

export interface AdapterCapabilities {
  /** Idempotent destination upsert is available (Part D / D9). */
  supportsWrite: boolean;
  supportsGetRecord: boolean;
  supportsRateLimitState: boolean;
}

export interface AdapterEntity {
  /** Stable identifier used in `sync_jobs.source_entity`. */
  key: string;
  displayName: string;
  /** Path template relative to the base URL, e.g. `/v1/orders`. */
  description: string;
  /** Fields observed on a real sample, when one could be fetched. */
  sampleFields?: string[];
}

export interface AdapterRecord {
  /** Stable key used for dedupe and idempotency. */
  key: string;
  /** The raw provider object. Callers must redact before storing. */
  payload: Record<string, unknown>;
  /** Provider version/ETag when the provider exposes one. */
  version?: string | null;
  /** Provider timestamp when the provider exposes one. */
  updatedAt?: string | null;
}

export interface AdapterPage {
  records: AdapterRecord[];
  /** Opaque cursor for the next page, or null when the source is exhausted. */
  nextCursor: string | null;
  /** Fields present on this page that are not in `knownFields`, for drift detection. */
  unknownFields: string[];
}

export type AdapterErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'conflict'
  | 'validation'
  | 'unsupported'
  | 'unknown';

export interface NormalizedAdapterError {
  kind: AdapterErrorKind;
  code: string;
  /** Operator-facing explanation. Never contains a credential or a full URL query. */
  message: string;
  retryable: boolean;
  status: number | null;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfterSeconds: number | null;
}

export class AdapterError extends Error {
  readonly normalized: NormalizedAdapterError;

  constructor(normalized: NormalizedAdapterError) {
    super(normalized.message);
    this.name = 'AdapterError';
    this.normalized = normalized;
  }
}

export class UnsupportedOperationError extends Error {
  readonly code = 'unsupported';
  constructor(operation: string) {
    super(`${operation} is not implemented by this adapter.`);
    this.name = 'UnsupportedOperationError';
  }
}

export interface ConnectionCredentials {
  /** Decrypted just-in-time on the server; never logged or returned. */
  token?: string | null;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

export interface AdapterContext {
  organizationId: string;
  connectionId: string;
  connectionName: string;
  environment: string;
  /** Non-secret, already validated settings. */
  settings: Record<string, unknown>;
  credentials: ConnectionCredentials;
  /** Called before every outbound request; throws when the quota is exhausted. */
  consumeQuota: () => Promise<void>;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string;
  /** Entities discovered during the probe, when the adapter can list them. */
  entities?: AdapterEntity[];
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  /** Requests SyncFix has made to this connection in the current minute. */
  usedInWindow: number;
  windowLimit: number;
}

export interface UpsertResult {
  /** Only ever set when the destination confirmed the write. */
  recordKey: string;
  version: string | null;
  /** False when the destination cannot prove the write happened. */
  confirmed: boolean;
  detail: string;
}

export interface ConnectorAdapter {
  readonly provider: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  /** Exactly what this adapter guarantees, surfaced verbatim in the UI. */
  readonly guarantees: string[];
  readonly limitations: string[];
  readonly setupSteps: string[];

  testConnection(ctx: AdapterContext): Promise<TestConnectionResult>;
  listSupportedEntities(ctx: AdapterContext): Promise<AdapterEntity[]>;
  fetchPage(ctx: AdapterContext, entity: string, cursor: string | null, limit: number): Promise<AdapterPage>;
  getRecord(ctx: AdapterContext, entity: string, key: string): Promise<AdapterRecord | null>;
  upsertRecord(ctx: AdapterContext, entity: string, record: AdapterRecord, idempotencyKey: string): Promise<UpsertResult>;
  normalizeError(error: unknown): NormalizedAdapterError;
  getRateLimitState(ctx: AdapterContext): Promise<RateLimitState>;
  /** Field names the adapter has previously seen for an entity (drift baseline). */
  knownFields?(ctx: AdapterContext, entity: string): Promise<string[]>;
}