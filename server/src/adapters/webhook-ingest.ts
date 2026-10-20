/**
 * Generic signed webhook ingestion connector (Part D / D8 "first release",
 * Part D / D5 "Webhook ingestion").
 *
 * This is a PUSH connector: the external system calls
 * `POST /api/v1/ingest/:publicEndpointId`. SyncFix is the receiver, so there is
 * no outbound request and therefore no SSRF surface.
 *
 * Guarantees
 * ----------
 * - The request body is authenticated with HMAC-SHA256 over
 *   `${timestamp}.${rawBody}` using the endpoint's signing secret. The secret is
 *   compared in constant time and is never logged, returned or embedded in a
 *   URL.
 * - A timestamp older/newer than the configured tolerance is rejected, which
 *   blocks replay of a captured request.
 * - Events are deduplicated by external event id, and - when the sender does
 *   not supply one - by SHA-256 of the exact raw body.
 * - Only redacted payloads are persisted; the raw body is never stored.
 *
 * Limitations
 * -----------
 * - The connector cannot read from or write to the remote system. It is a
 *   source only. A job may use it as its source; a destination must be a
 *   connection whose adapter supports write (the generic REST connector).
 * - Because records arrive event by event there is no page cursor. The engine
 *   reads buffered events in receipt order and uses the event id as the
 *   checkpoint.
 */

import {
  webhookIngestSettingsSchema,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type WebhookIngestSettingsInput,
} from '@syncfix/shared';

import { AdapterError, UnsupportedOperationError, type ConnectorAdapter, type NormalizedAdapterError, type TestConnectionResult, type AdapterEntity } from './types.js';

export class WebhookIngestAdapter implements ConnectorAdapter {
  readonly provider = 'webhook_ingest';
  readonly kind = 'webhook_ingest' as const;
  readonly displayName = 'Signed webhook ingestion';
  readonly capabilities = {
    /** Push-only: this adapter can never write to a destination. */
    supportsWrite: false,
    supportsGetRecord: false,
    supportsRateLimitState: true,
  } as const;

  readonly guarantees = [
    'HMAC-SHA256 signature verification over the timestamp and the exact raw body.',
    'Constant-time signature comparison; the signing secret is never logged, returned or placed in a URL.',
    'Replay protection: requests outside the timestamp tolerance are rejected.',
    'Deduplication by external event id, and by SHA-256 of the raw body when the sender supplies no id.',
    'Only redacted payloads are persisted; the raw request body is never stored.',
  ];

  readonly limitations = [
    'This connector is a source only. It cannot push records into another system.',
    'Records arrive one event at a time, so there is no page cursor; the checkpoint is the last event id.',
    'A sender that cannot compute an HMAC signature cannot use this endpoint.',
  ];

  readonly setupSteps = [
    'Create a connection with provider "Signed webhook ingestion".',
    'Create a webhook endpoint, which produces a public URL and a signing secret.',
    'Copy the secret once: it is shown only at creation and at rotation.',
    'Configure the sender to send the signature header and a Unix timestamp header.',
    'Send the event id in the payload field configured as the external event id path (default "id").',
  ];

  private settings(input: Record<string, unknown>): WebhookIngestSettingsInput {
    return webhookIngestSettingsSchema.parse(input ?? {});
  }

  async testConnection(): Promise<TestConnectionResult> {
    // The endpoint is reachable by definition once it exists; reachability is
    // proven by the first ingested event, not by an outbound probe.
    return {
      ok: true,
      latencyMs: 0,
      errorCode: null,
      message:
        'This connector receives events. It becomes "verified" the first time a correctly signed request arrives.',
      entities: [
        {
          key: 'webhook_events',
          displayName: 'Received webhook events',
          description: 'Buffered, deduplicated events accepted at this organization endpoints.',
        },
      ],
    };
  }

  async listSupportedEntities(): Promise<AdapterEntity[]> {
    return (await this.testConnection()).entities ?? [];
  }

  async fetchPage(): Promise<never> {
    throw new UnsupportedOperationError(
      'fetchPage: buffered events are read by the webhook service, not over HTTP',
    );
  }

  async getRecord(): Promise<never> {
    throw new UnsupportedOperationError('getRecord');
  }

  async upsertRecord(): Promise<never> {
    throw new UnsupportedOperationError('upsertRecord: this connector is a source only');
  }

  normalizeError(error: unknown): NormalizedAdapterError {
    if (error instanceof AdapterError) return error.normalized;
    return {
      kind: 'unknown',
      code: 'unknown_error',
      message: error instanceof Error ? error.message : 'Unknown ingestion error.',
      retryable: false,
      status: null,
      retryAfterSeconds: null,
    };
  }

  async getRateLimitState(): Promise<{
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
    usedInWindow: number;
    windowLimit: number;
  }> {
    return { limit: null, remaining: null, resetAt: null, usedInWindow: 0, windowLimit: 0 };
  }
}

/** Exposed so the route can use the same tolerance constant. */
export { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS };