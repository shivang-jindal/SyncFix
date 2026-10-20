/**
 * Connections (Part D / D2, D4.2, D9).
 *
 * Credentials are sealed with AES-256-GCM at rest, are never returned by any
 * read path, are never logged, and can be rotated without re-entering the whole
 * connection. A connection is only ever called "verified" after a real adapter
 * test succeeded (Part D / D10).
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import {
  ORG_QUOTAS,
  restSettingsSchema,
  webhookIngestSettingsSchema,
  type ConnectionListItem,
  type ConnectionTestRun,
  type ConnectionEnvironment,
  type ConnectionStatus,
  type ProviderKind,
} from '@syncfix/shared';

import { createAdapter, providerCatalogue } from '../adapters/index.js';
import type { AdapterContext, ConnectorAdapter } from '../adapters/types.js';
import type { AppDatabase } from '../db/client.js';
import {
  connectionTestRuns,
  connections,
  integrationRateLimits,
  syncJobs,
} from '../db/schema.js';
import { badRequest, conflict, integrationUnavailable, notFound, unprocessable } from '../errors.js';
import { maskSecret, openCredentials, sealCredentials } from '../lib/crypto.js';
import { redactObject } from '../logger.js';
import type { AuditService } from './audit.service.js';

export interface ConnectionRecord {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  environment: string;
  status: string;
  encryptedCredentials: string | null;
  settings: Record<string, unknown>;
  credentialKeys: string[];
  scopes: string[];
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CredentialEntry {
  key: string;
  value: string;
}

export interface ConnectionServiceDeps {
  db: AppDatabase;
  audit: AuditService;
  encryptionKey: Buffer | null;
}

export class ConnectionService {
  private readonly db: AppDatabase;
  private readonly audit: AuditService;
  private readonly encryptionKey: Buffer | null;

  constructor(deps: ConnectionServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.encryptionKey = deps.encryptionKey;
  }

  get encryptionConfigured(): boolean {
    return this.encryptionKey !== null;
  }

  catalogue() {
    return providerCatalogue();
  }

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                    */
  /* ---------------------------------------------------------------------- */

  async create(input: {
    organizationId: string;
    actorUserId: string;
    provider: string;
    name: string;
    environment: string;
    credentials: Record<string, string | undefined>;
    scopes: string[];
    settings: Record<string, unknown>;
    requestId?: string | null;
    ipAddress?: string | null;
  }): Promise<ConnectionRecord> {
    const adapter = createAdapter(input.provider);
    const normalizedSettings = this.normalizeSettings(input.provider, input.settings);
    const credentials = Object.entries(input.credentials).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    );

    const existingCount = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(connections)
      .where(eq(connections.organizationId, input.organizationId));
    if ((existingCount[0]?.count ?? 0) >= ORG_QUOTAS.connections) {
      throw unprocessable(
        `This organization already has the maximum of ${ORG_QUOTAS.connections} connections.`,
      );
    }

    const needsCredentials = this.credentialsRequired(input.provider, normalizedSettings);
    if (needsCredentials && credentials.length === 0) {
      throw badRequest('This connection needs a credential before it can be tested.', {
        credentials: ['Add a credential'],
      });
    }

    const sealed = credentials.length > 0 ? this.seal(Object.fromEntries(credentials)) : null;
    const status = credentials.length > 0 ? 'configured' : 'not_configured';

    const inserted = await this.db
      .insert(connections)
      .values({
        organizationId: input.organizationId,
        provider: input.provider,
        name: input.name.trim(),
        environment: input.environment,
        status,
        encryptedCredentials: sealed,
        settings: normalizedSettings,
        credentialKeys: credentials.map(([key]) => key),
        scopes: input.scopes,
        createdBy: input.actorUserId,
      })
      .returning();

    const connection = inserted[0]!;
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'connection.created',
      entityType: 'connection',
      entityId: connection.id,
      metadata: { provider: input.provider, environment: input.environment, hasCredentials: sealed !== null },
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
    });

    void adapter;
    return connection;
  }

  async update(input: {
    organizationId: string;
    connectionId: string;
    actorUserId: string;
    patch: {
      name?: string;
      environment?: string;
      credentials?: Record<string, string | undefined>;
      scopes?: string[];
      settings?: Record<string, unknown>;
    };
    requestId?: string | null;
  }): Promise<ConnectionRecord> {
    const current = await this.requireOwned(input.organizationId, input.connectionId);
    const updates: Partial<typeof connections.$inferInsert> = { updatedAt: new Date() };

    if (input.patch.name !== undefined) updates.name = input.patch.name.trim();
    if (input.patch.environment !== undefined) updates.environment = input.patch.environment;
    if (input.patch.scopes !== undefined) updates.scopes = input.patch.scopes;

    let statusAfterUpdate = current.status;
    if (input.patch.settings !== undefined) {
      updates.settings = this.normalizeSettings(
        current.provider,
        { ...current.settings, ...input.patch.settings },
      );
      // Any change to a verified connection invalidates the verification.
      statusAfterUpdate = current.status === 'verified' ? 'configured' : current.status;
    }

    if (input.patch.credentials !== undefined) {
      const entries = Object.entries(input.patch.credentials).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
      );
      if (entries.length > 0) {
        // Rotation-style merge: existing keys keep their value unless replaced.
        const merged = { ...this.open(current), ...Object.fromEntries(entries) };
        updates.encryptedCredentials = this.seal(merged);
        updates.credentialKeys = Object.keys(merged).sort();
        statusAfterUpdate = 'configured';
      }
    }

    updates.status = statusAfterUpdate;
    const updated = await this.db
      .update(connections)
      .set(updates)
      .where(and(eq(connections.id, current.id), eq(connections.organizationId, input.organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Connection');

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'connection.updated',
      entityType: 'connection',
      entityId: current.id,
      metadata: redactObject({
        fields: Object.keys(input.patch),
        credentialsRotated: input.patch.credentials !== undefined,
      }),
      requestId: input.requestId ?? null,
    });

    return updated[0]!;
  }

  /** Dedicated rotation flow; returns nothing secret back to the browser. */
  async rotate(input: {
    organizationId: string;
    connectionId: string;
    actorUserId: string;
    credentials: Record<string, string | undefined>;
    requestId?: string | null;
  }): Promise<ConnectionRecord> {
    const current = await this.requireOwned(input.organizationId, input.connectionId);
    const entries = Object.entries(input.credentials).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    );
    if (entries.length === 0) {
      throw badRequest('Provide at least one new credential value.', {
        credentials: ['Nothing to rotate'],
      });
    }
    const merged = { ...this.open(current), ...Object.fromEntries(entries) };
    const updated = await this.db
      .update(connections)
      .set({
        encryptedCredentials: this.seal(merged),
        credentialKeys: Object.keys(merged).sort(),
        status: 'configured',
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, current.id), eq(connections.organizationId, input.organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Connection');

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'connection.credentials_rotated',
      entityType: 'connection',
      entityId: current.id,
      metadata: { keys: entries.map(([key]) => key) },
      requestId: input.requestId ?? null,
    });
    return updated[0]!;
  }

  async disable(input: {
    organizationId: string;
    connectionId: string;
    actorUserId: string;
    enabled: boolean;
    requestId?: string | null;
  }): Promise<ConnectionRecord> {
    const current = await this.requireOwned(input.organizationId, input.connectionId);
    const updated = await this.db
      .update(connections)
      .set({
        status: input.enabled ? (current.status === 'disabled' ? 'configured' : current.status) : 'disabled',
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, current.id), eq(connections.organizationId, input.organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Connection');
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.enabled ? 'connection.enabled' : 'connection.disabled',
      entityType: 'connection',
      entityId: current.id,
      requestId: input.requestId ?? null,
    });
    return updated[0]!;
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async get(organizationId: string, connectionId: string): Promise<ConnectionRecord> {
    return this.requireOwned(organizationId, connectionId);
  }

  async requireOwned(organizationId: string, connectionId: string): Promise<ConnectionRecord> {
    const rows = await this.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          // Tenant scoping is part of the WHERE clause: a foreign id is a 404,
          // never a 403 (Part A / A5).
          eq(connections.organizationId, organizationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Connection');
    return row;
  }

  async list(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      q?: string;
      provider?: string;
      status?: string;
      sort: string;
      order: 'asc' | 'desc';
    },
  ): Promise<{ items: ConnectionRecord[]; total: number }> {
    const filters = [eq(connections.organizationId, organizationId)];
    if (query.provider) filters.push(eq(connections.provider, query.provider));
    if (query.status && query.status !== 'all') filters.push(eq(connections.status, query.status));
    if (query.q) {
      const pattern = `%${query.q.toLowerCase()}%`;
      filters.push(sql`lower(${connections.name}) like ${pattern}`);
    }
    const where = and(...filters);

    const sortColumn =
      query.sort === 'created_at'
        ? connections.createdAt
        : query.sort === 'status'
          ? connections.status
          : query.sort === 'last_verified_at'
            ? connections.lastVerifiedAt
            : connections.name;
    const direction = query.order === 'asc' ? asc : desc;

    const rows = await this.db
      .select()
      .from(connections)
      .where(where)
      .orderBy(direction(sortColumn), asc(connections.name))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const counts = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(connections)
      .where(where);
    return { items: rows, total: counts[0]?.count ?? 0 };
  }

  async recentTestRuns(connectionId: string, limit = 10): Promise<ConnectionTestRun[]> {
    return this.db
      .select()
      .from(connectionTestRuns)
      .where(eq(connectionTestRuns.connectionId, connectionId))
      .orderBy(desc(connectionTestRuns.testedAt))
      .limit(Math.min(limit, 50))
      .then((rows): ConnectionTestRun[] => rows.map((row): ConnectionTestRun => ({
        ...row,
        status: (row.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
        testedAt: row.testedAt instanceof Date ? row.testedAt.toISOString() : String(row.testedAt),
      })));
  }

  /* ---------------------------------------------------------------------- */
  /* Adapter plumbing                                                       */
  /* ---------------------------------------------------------------------- */

  adapterFor(connection: ConnectionRecord, knownFields?: Record<string, string[]>): ConnectorAdapter {
    return createAdapter(connection.provider, knownFields);
  }

  /**
   * Builds the adapter context. Credentials are decrypted here and nowhere
   * else; the returned object is short-lived and never serialized.
   */
  contextFor(connection: ConnectionRecord): AdapterContext {
    const secrets = this.open(connection);
    return {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      connectionName: connection.name,
      environment: connection.environment,
      settings: connection.settings,
      credentials: {
        token: secrets.token ?? secrets.access_token ?? null,
        apiKey: secrets.api_key ?? secrets.apiKey ?? null,
        username: secrets.username ?? null,
        password: secrets.password ?? null,
      },
      consumeQuota: () => this.consumeQuota(connection),
    };
  }

  /**
   * Runs a real adapter test and records the outcome. The connection becomes
   * `verified` only when the adapter reports success.
   */
  async test(input: {
    organizationId: string;
    connectionId: string;
    actorUserId: string;
  }): Promise<{ connection: ConnectionRecord; testRun: ConnectionTestRun; result: Awaited<ReturnType<ConnectorAdapter['testConnection']>> }> {
    const connection = await this.requireOwned(input.organizationId, input.connectionId);
    if (connection.status === 'disabled') {
      throw unprocessable('This connection is disabled. Enable it before testing.');
    }
    if (connection.provider === 'webhook_ingest') {
      // No outbound request is possible; verification happens on first receipt.
      throw unprocessable(
        'This connector receives events. It is verified automatically when the first correctly signed event arrives.',
      );
    }

    const adapter = this.adapterFor(connection);
    const result = await adapter.testConnection(this.contextFor(connection));
    const status: ConnectionStatus = result.ok ? 'verified' : 'error';

    const [testRun] = await this.db
      .insert(connectionTestRuns)
      .values({
        organizationId: input.organizationId,
        connectionId: connection.id,
        status: result.ok ? 'passed' : 'failed',
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        safeMessage: result.message.slice(0, 500),
      })
      .returning()
      .then((rows) => rows.map((row) => ({
        ...row,
        status: row.status as 'passed' | 'failed',
        testedAt: row.testedAt instanceof Date ? row.testedAt.toISOString() : String(row.testedAt),
      })) as ConnectionTestRun[]);

    const [updated] = await this.db
      .update(connections)
      .set({
        status,
        lastVerifiedAt: result.ok ? new Date() : connection.lastVerifiedAt,
        lastErrorCode: result.ok ? null : result.errorCode,
        lastErrorMessage: result.ok ? null : result.message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connection.id))
      .returning();

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'connection.tested',
      entityType: 'connection',
      entityId: connection.id,
      metadata: { ok: result.ok, errorCode: result.errorCode, latencyMs: result.latencyMs },
    });

    return { connection: updated ?? connection, testRun: testRun!, result };
  }

  /**
   * Per-organization request budget (Part D / D9). Throws when the minute is
   * exhausted so the engine reports a rate_limited issue instead of hammering
   * a provider.
   */
  async consumeQuota(connection: ConnectionRecord): Promise<void> {
    const limit = this.quotaOf(connection);
    if (limit === null) return;

    const windowStart = new Date();
    windowStart.setUTCSeconds(0, 0);

    await this.db
      .insert(integrationRateLimits)
      .values({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        windowStart,
        requestCount: 1,
      })
      .onConflictDoUpdate({
        target: [integrationRateLimits.connectionId, integrationRateLimits.windowStart],
        set: { requestCount: sql`${integrationRateLimits.requestCount} + 1`, updatedAt: new Date() },
      });

    const rows = await this.db
      .select({ count: integrationRateLimits.requestCount })
      .from(integrationRateLimits)
      .where(
        and(
          eq(integrationRateLimits.connectionId, connection.id),
          eq(integrationRateLimits.windowStart, windowStart),
        ),
      )
      .limit(1);

    const used = rows[0]?.count ?? 0;
    if (used > limit) {
      throw integrationUnavailable(
        `SyncFix reached the configured budget of ${limit} requests per minute for "${connection.name}". Increase it or wait for the next window.`,
        { connectionId: connection.id, limit, used },
      );
    }
  }

  async rateLimitState(connection: ConnectionRecord) {
    const adapter = this.adapterFor(connection);
    const state = await adapter.getRateLimitState(this.contextFor(connection));
    const windowStart = new Date();
    windowStart.setUTCSeconds(0, 0);
    const rows = await this.db
      .select({ count: integrationRateLimits.requestCount })
      .from(integrationRateLimits)
      .where(
        and(
          eq(integrationRateLimits.connectionId, connection.id),
          eq(integrationRateLimits.windowStart, windowStart),
        ),
      )
      .limit(1);
    return { ...state, usedInWindow: rows[0]?.count ?? 0 };
  }

  /** Refuse to delete a connection that a job still references. */
  async assertUnused(organizationId: string, connectionId: string): Promise<void> {
    const rows = await this.db
      .select({ id: syncJobs.id, name: syncJobs.name })
      .from(syncJobs)
      .where(
        and(
          eq(syncJobs.organizationId, organizationId),
          sql`(${syncJobs.sourceConnectionId} = ${connectionId} or ${syncJobs.destinationConnectionId} = ${connectionId})`,
        ),
      )
      .limit(5);
    if (rows[0]) {
      throw conflict(
        `This connection is still used by ${rows.length === 1 ? 'the job' : 'jobs'} "${rows[0].name}". Repoint or delete the job first.`,
        { jobIds: rows.map((row) => row.id) },
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Presentation                                                            */
  /* ---------------------------------------------------------------------- */

  toListItem(connection: ConnectionRecord, overrides: { lastErrorCode?: string | null; lastErrorMessage?: string | null } = {}): ConnectionListItem {
    let supportsWrite = false;
    try {
      supportsWrite = createAdapter(connection.provider).capabilities.supportsWrite;
    } catch {
      supportsWrite = false;
    }
    return {
      id: connection.id,
      provider: connection.provider,
      providerKind: connection.provider as ProviderKind,
      name: connection.name,
      environment: connection.environment as ConnectionEnvironment,
      status: connection.status as ConnectionStatus,
      credentialMasks: connection.credentialKeys.map((key) => ({
        key,
        masked: maskSecret(this.peekCredential(connection, key)),
      })),
      scopes: connection.scopes,
      settings: connection.settings,
      supportsWrite,
      lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
      lastErrorCode: overrides.lastErrorCode ?? connection.lastErrorCode,
      lastErrorMessage: overrides.lastErrorMessage ?? connection.lastErrorMessage,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private normalizeSettings(provider: string, settings: Record<string, unknown>): Record<string, unknown> {
    if (provider === 'rest') {
      const parsed = restSettingsSchema.safeParse(settings);
      if (!parsed.success) {
        throw badRequest('The REST connection settings are not valid.', {
          settings: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      }
      return parsed.data;
    }
    if (provider === 'webhook_ingest') {
      const parsed = webhookIngestSettingsSchema.safeParse(settings);
      if (!parsed.success) {
        throw badRequest('The webhook ingestion settings are not valid.', {
          settings: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      }
      return parsed.data;
    }
    throw badRequest(`Unknown provider "${provider}".`, { provider: ['Unsupported provider'] });
  }

  private credentialsRequired(provider: string, settings: Record<string, unknown>): boolean {
    if (provider === 'webhook_ingest') return false;
    const authScheme = (settings as { authScheme?: string }).authScheme ?? 'bearer';
    return authScheme !== 'none';
  }

  private quotaOf(connection: ConnectionRecord): number | null {
    if (connection.provider !== 'rest') return null;
    const value = (connection.settings as { requestsPerMinute?: unknown }).requestsPerMinute;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  private seal(values: Record<string, string>): string {
    if (!this.encryptionKey) {
      throw unprocessable(
        'ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored. Ask an operator to set it and restart the API.',
      );
    }
    return sealCredentials(this.encryptionKey, values);
  }

  /** Decrypts the stored credential blob. Callers must not persist the result. */
  private open(connection: ConnectionRecord): Record<string, string> {
    if (!connection.encryptedCredentials) return {};
    if (!this.encryptionKey) {
      throw integrationUnavailable(
        'ENCRYPTION_KEY is not configured, so stored credentials cannot be decrypted. Ask an operator to restore the key used when they were saved.',
      );
    }
    try {
      return openCredentials(this.encryptionKey, connection.encryptedCredentials);
    } catch {
      throw integrationUnavailable(
        'The stored credential could not be decrypted with the current ENCRYPTION_KEY. Rotate the credential to restore access.',
      );
    }
  }

  /** Last four characters only, for the masked UI. Never the whole value. */
  private peekCredential(connection: ConnectionRecord, key: string): string | null {
    if (!connection.encryptedCredentials || !this.encryptionKey) return null;
    try {
      const values = openCredentials(this.encryptionKey, connection.encryptedCredentials);
      return values[key] ?? null;
    } catch {
      return null;
    }
  }
}