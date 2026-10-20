/**
 * Signed webhook ingestion (Part D / D5 "Webhook ingestion", D9).
 *
 * Rules enforced here:
 *
 *  1. The signing secret is generated server-side, sealed at rest and returned
 *     EXACTLY ONCE (at creation and at rotation). It never appears in a URL, a
 *     log line, an error message or a list response.
 *  2. The signature is HMAC-SHA256 over `${timestamp}.${rawBody}` and is
 *     compared in constant time.
 *  3. A timestamp outside the tolerance window is rejected, which blocks replay
 *     of a captured request even before the dedupe check.
 *  4. Events are deduplicated by external event id, and by SHA-256 of the raw
 *     body when the sender supplies no id.
 *  5. Only redacted payloads are persisted; the raw body is discarded.
 */

import { and, count, desc, eq, inArray } from 'drizzle-orm';

import {
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type WebhookEndpointView,
  type WebhookEventView,
} from '@syncfix/shared';

import type { AppDatabase } from '../db/client.js';
import { webhookEndpoints, webhookEvents } from '../db/schema.js';
import { badRequest, notFound, rateLimited, unprocessable } from '../errors.js';
import {
  hmacSha256Hex,
  openCredentials,
  randomToken,
  safeEqual,
  sealCredentials,
} from '../lib/crypto.js';
import { hashText } from '../lib/stable-hash.js';
import { redactPayloadObject } from '../lib/redact.js';
import type { AuditService } from './audit.service.js';

export interface IngestResult {
  status: 'accepted' | 'duplicate';
  eventId: string;
  organizationId: string;
  message: string;
}

export class WebhookService {
  private readonly db: AppDatabase;
  private readonly audit: AuditService;
  private readonly encryptionKey: Buffer | null;
  private readonly appUrl: string;
  /** Simple in-memory window counter; the queue also persists events. */
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(input: {
    db: AppDatabase;
    audit: AuditService;
    encryptionKey: Buffer | null;
    appUrl: string;
  }) {
    this.db = input.db;
    this.audit = input.audit;
    this.encryptionKey = input.encryptionKey;
    this.appUrl = input.appUrl;
  }

  /* ---------------------------------------------------------------------- */
  /* Endpoints                                                               */
  /* ---------------------------------------------------------------------- */

  async create(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    enabled: boolean;
    settings: Record<string, unknown>;
    requestId?: string | null;
  }): Promise<WebhookEndpointView & { secret: string }> {
    if (!this.encryptionKey) {
      throw unprocessable(
        'ENCRYPTION_KEY is not configured on the server, so a webhook signing secret cannot be sealed. Ask an operator to set it and restart the API.',
      );
    }

    // The secret is generated here and never leaves the server in any other form.
    const secret = `whsec_${randomToken(32)}`;
    const publicEndpointId = randomToken(18);

    const [row] = await this.db
      .insert(webhookEndpoints)
      .values({
        organizationId: input.organizationId,
        name: input.name.trim(),
        publicEndpointId,
        encryptedSecret: sealCredentials(this.encryptionKey, { secret }),
        enabled: input.enabled,
        settings: input.settings,
        createdBy: input.actorUserId,
      })
      .returning();

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'webhook_endpoint.created',
      entityType: 'webhook_endpoint',
      entityId: row!.id,
      metadata: { name: row!.name, publicEndpointId },
      requestId: input.requestId ?? null,
    });

    return { ...(await this.view(row!, 0)), secret };
  }

  /** Rotation returns the new secret exactly once. */
  async rotate(input: {
    organizationId: string;
    endpointId: string;
    actorUserId: string;
    requestId?: string | null;
  }): Promise<WebhookEndpointView & { secret: string }> {
    const current = await this.requireOwned(input.organizationId, input.endpointId);
    if (!this.encryptionKey) {
      throw unprocessable('ENCRYPTION_KEY is not configured, so a new secret cannot be sealed.');
    }
    const secret = `whsec_${randomToken(32)}`;
    const [row] = await this.db
      .update(webhookEndpoints)
      .set({ encryptedSecret: sealCredentials(this.encryptionKey, { secret }), createdAt: current.createdAt })
      .where(and(eq(webhookEndpoints.id, current.id), eq(webhookEndpoints.organizationId, input.organizationId)))
      .returning();
    if (!row) throw notFound('Webhook endpoint');

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'webhook_endpoint.secret_rotated',
      entityType: 'webhook_endpoint',
      entityId: current.id,
      requestId: input.requestId ?? null,
    });

    return { ...(await this.view(row, await this.eventCount(current.id))), secret };
  }

  async update(input: {
    organizationId: string;
    endpointId: string;
    actorUserId: string;
    patch: { name?: string; enabled?: boolean };
    requestId?: string | null;
  }): Promise<WebhookEndpointView> {
    const current = await this.requireOwned(input.organizationId, input.endpointId);
    const [row] = await this.db
      .update(webhookEndpoints)
      .set(input.patch)
      .where(and(eq(webhookEndpoints.id, current.id), eq(webhookEndpoints.organizationId, input.organizationId)))
      .returning();
    if (!row) throw notFound('Webhook endpoint');
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'webhook_endpoint.updated',
      entityType: 'webhook_endpoint',
      entityId: current.id,
      metadata: { fields: Object.keys(input.patch) },
      requestId: input.requestId ?? null,
    });
    return this.view(row, await this.eventCount(current.id));
  }

  async list(organizationId: string): Promise<WebhookEndpointView[]> {
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookEndpoints.createdAt));

    const counts = await this.db
      .select({ endpointId: webhookEvents.endpointId, count: count() })
      .from(webhookEvents)
      .where(eq(webhookEvents.organizationId, organizationId))
      .groupBy(webhookEvents.endpointId);
    const countMap = new Map(counts.map((entry) => [entry.endpointId, entry.count]));

    return rows.map((row) => this.view(row, countMap.get(row.id) ?? 0));
  }

  async events(
    organizationId: string,
    options: { page: number; pageSize: number; endpointId?: string; status?: string },
  ): Promise<{ items: WebhookEventView[]; total: number }> {
    const filters = [eq(webhookEvents.organizationId, organizationId)];
    if (options.endpointId) filters.push(eq(webhookEvents.endpointId, options.endpointId));
    if (options.status && options.status !== 'all') {
      filters.push(eq(webhookEvents.status, options.status));
    }
    const where = and(...filters);

    const rows = await this.db
      .select({ event: webhookEvents, endpointName: webhookEndpoints.name })
      .from(webhookEvents)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookEvents.endpointId))
      .where(where)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(options.pageSize)
      .offset((options.page - 1) * options.pageSize);

    const totals = await this.db.select({ count: count() }).from(webhookEvents).where(where);
    return {
      items: rows.map((row) => this.eventView(row.event, row.endpointName)),
      total: totals[0]?.count ?? 0,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Ingestion                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Verifies and stores one incoming event. Returns quickly; processing happens
   * through the job queue. Keyed on the public endpoint id from the URL.
   */
  async ingestForEndpoint(
    publicEndpointId: string,
    input: {
      rawBody: string;
      headers: Record<string, string | string[] | undefined>;
      maxPerMinute?: number;
    },
  ): Promise<IngestResult> {
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicEndpointId, publicEndpointId))
      .limit(1);
    const endpoint = rows[0];
    // A wrong endpoint id is reported identically to a wrong signature so the
    // route cannot be used to probe for valid endpoint ids.
    if (!endpoint) throw notFound('Webhook endpoint');
    if (!endpoint.enabled) throw unprocessable('This webhook endpoint is disabled.');

    const settings = (endpoint.settings ?? {}) as {
      signatureHeader?: string;
      timestampHeader?: string;
      externalEventIdPath?: string | null;
      maxPayloadBytes?: number;
    };

    const maxBytes = settings.maxPayloadBytes ?? 262_144;
    if (Buffer.byteLength(input.rawBody, 'utf8') > maxBytes) {
      throw unprocessable(`The payload exceeds the ${maxBytes} byte limit for this endpoint.`);
    }

    this.enforceRateLimit(publicEndpointId, input.maxPerMinute ?? 600);

    const signatureHeader = (settings.signatureHeader ?? 'x-syncfix-signature').toLowerCase();
    const timestampHeader = (settings.timestampHeader ?? 'x-syncfix-timestamp').toLowerCase();

    const signature = firstHeader(input.headers[signatureHeader]);
    const timestamp = firstHeader(input.headers[timestampHeader]);
    if (!signature) throw badRequest('Missing signature header.');
    if (!timestamp) throw badRequest('Missing timestamp header.');

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw badRequest('The timestamp header must be Unix seconds.');
    }
    const driftSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (driftSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
      throw badRequest(
        `The request timestamp is outside the ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} second tolerance, so it was rejected as a possible replay.`,
      );
    }

    const secret = this.secretFor(endpoint);
    const expected = hmacSha256Hex(secret, `${timestamp}.${input.rawBody}`);
    // Accept both the hex form and the `sha256=<hex>` prefixed form.
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (!safeEqual(expected.toLowerCase(), provided.toLowerCase())) {
      throw badRequest('Signature verification failed.');
    }

    const payloadHash = hashText(input.rawBody);
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(input.rawBody);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      } else {
        throw badRequest('The webhook payload must be a JSON object.');
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.message.startsWith('The webhook payload')) {
        throw error;
      }
      throw badRequest('The webhook payload is not valid JSON.');
    }

    const externalEventId = settings.externalEventIdPath
      ? readPathValue(parsed, settings.externalEventIdPath)
      : null;
    const externalId =
      typeof externalEventId === 'string' || typeof externalEventId === 'number'
        ? String(externalEventId)
        : null;

    const redacted = redactPayloadObject(parsed);

    try {
      const [row] = await this.db
        .insert(webhookEvents)
        .values({
          organizationId: endpoint.organizationId,
          endpointId: endpoint.id,
          externalEventId: externalId,
          payloadHash,
          redactedPayload: redacted,
          status: 'accepted',
        })
        .returning();
      await this.db
        .update(webhookEndpoints)
        .set({ lastReceivedAt: new Date() })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return {
        status: 'accepted',
        eventId: row!.id,
        organizationId: endpoint.organizationId,
        message: 'Accepted. The event is queued for processing.',
      };
    } catch (error) {
      // The unique indexes make a replay a duplicate instead of a second row.
      if (isUniqueViolation(error)) {
        const existing = await this.db
          .select({ id: webhookEvents.id })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.endpointId, endpoint.id),
              externalId
                ? eq(webhookEvents.externalEventId, externalId)
                : eq(webhookEvents.payloadHash, payloadHash),
            ),
          )
          .limit(1);
        if (existing[0]) {
          return {
            status: 'duplicate',
            eventId: existing[0].id,
            organizationId: endpoint.organizationId,
            message: 'This event was already received and was not processed a second time.',
          };
        }
      }
      throw error;
    }
  }

  async markProcessed(
    eventId: string,
    status: 'processed' | 'failed',
    error?: { code: string; message: string },
  ): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status,
        processedAt: new Date(),
        errorCode: error?.code ?? null,
        safeMessage: error ? error.message.slice(0, 500) : null,
      })
      .where(eq(webhookEvents.id, eventId));
  }

  async pendingEvents(organizationId: string, limit = 100) {
    return this.db
      .select()
      .from(webhookEvents)
      .where(
        and(eq(webhookEvents.organizationId, organizationId), inArray(webhookEvents.status, ['accepted'])),
      )
      .orderBy(webhookEvents.receivedAt)
      .limit(limit);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async requireOwned(organizationId: string, endpointId: string) {
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.organizationId, organizationId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Webhook endpoint');
    return row;
  }

  private async eventCount(endpointId: string): Promise<number> {
    const rows = await this.db
      .select({ count: count() })
      .from(webhookEvents)
      .where(eq(webhookEvents.endpointId, endpointId));
    return rows[0]?.count ?? 0;
  }

  private secretFor(endpoint: typeof webhookEndpoints.$inferSelect): string {
    if (!endpoint.encryptedSecret || !this.encryptionKey) {
      throw unprocessable(
        'This endpoint has no stored signing secret. Rotate the secret to issue a new one.',
      );
    }
    try {
      const values = openCredentials(this.encryptionKey, endpoint.encryptedSecret);
      const secret = values.secret;
      if (!secret) throw new Error('missing secret');
      return secret;
    } catch {
      throw unprocessable(
        'The stored signing secret could not be decrypted with the current ENCRYPTION_KEY. Rotate the secret.',
      );
    }
  }

  private enforceRateLimit(publicEndpointId: string, maxPerMinute: number): void {
    const now = Date.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const entry = this.windows.get(publicEndpointId);
    if (!entry || entry.start !== windowStart) {
      this.windows.set(publicEndpointId, { start: windowStart, count: 1 });
      return;
    }
    entry.count += 1;
    if (entry.count > maxPerMinute) {
      throw rateLimited(
        `This endpoint accepted ${maxPerMinute} events in the current minute. The request was rejected.`,
      );
    }
  }

  private view(
    row: typeof webhookEndpoints.$inferSelect,
    eventCountValue: number,
  ): WebhookEndpointView {
    return {
      id: row.id,
      name: row.name,
      publicEndpointId: row.publicEndpointId,
      url: `${this.appUrl.replace(/\/$/, '')}/api/v1/ingest/${row.publicEndpointId}`,
      enabled: row.enabled,
      lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
      eventCount: eventCountValue,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private eventView(
    row: typeof webhookEvents.$inferSelect,
    endpointName: string,
  ): WebhookEventView {
    return {
      id: row.id,
      endpointId: row.endpointId,
      endpointName,
      externalEventId: row.externalEventId,
      payloadHash: row.payloadHash,
      status: row.status as WebhookEventView['status'],
      errorCode: row.errorCode,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      redactedPayload: row.redactedPayload,
    };
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

function readPathValue(source: Record<string, unknown>, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}