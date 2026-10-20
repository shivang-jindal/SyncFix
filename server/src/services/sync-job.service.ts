/**
 * Sync jobs (Part D / D4.3).
 *
 * Every job is created paused. Enabling the schedule is a separate, explicit,
 * audited action (Part D / D10: "No sync job runs without an explicit enable
 * action"). v1 is one-way source -> destination only.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  CONFLICT_POLICIES,
  isValidTimeZone,
  ORG_QUOTAS,
  type ConflictPolicy,
  type RunStatus,
  type RunTrigger,
  type SyncJobListItem,
} from '@syncfix/shared';

import { supportsDestinationWrite } from '../adapters/index.js';
import type { AppDatabase } from '../db/client.js';
import {
  connections,
  syncIssues,
  syncJobs,
  syncMappings,
  syncRecords,
  syncRuns,
} from '../db/schema.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';
import {
  applyMapping,
  assertMappingInput,
  normalizeMapping,
  writePath,
  type MappingValidationResult,
  validateMappings,
} from './mapping.service.js';

export interface SyncJobRecord {
  id: string;
  organizationId: string;
  name: string;
  sourceConnectionId: string;
  destinationConnectionId: string;
  sourceEntity: string;
  destinationEntity: string;
  mode: string;
  scheduleCron: string | null;
  timezone: string;
  enabled: boolean;
  conflictPolicy: string;
  batchSize: number;
  retryPolicy: { mode: string; maxAttempts: number; backoffSeconds: number };
  filters: Array<{ field: string; operator: string; value?: unknown }>;
  checkpoint: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CronDecision {
  due: boolean;
  /** Minutes since the epoch, used as a stable enqueue idempotency key. */
  slotKey: string;
}

export class SyncJobService {
  private readonly db: AppDatabase;
  private readonly audit: AuditService;

  constructor(db: AppDatabase, audit: AuditService) {
    this.db = db;
    this.audit = audit;
  }

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                    */
  /* ---------------------------------------------------------------------- */

  async create(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    sourceConnectionId: string;
    destinationConnectionId: string;
    sourceEntity: string;
    destinationEntity: string;
    conflictPolicy: string;
    scheduleCron: string | null;
    timezone: string;
    batchSize: number;
    retryPolicy: { mode: string; maxAttempts: number; backoffSeconds: number };
    filters: Array<{ field: string; operator: string; value?: unknown }>;
    mappings: Array<ReturnType<typeof assertMappingInput>>;
    requestId?: string | null;
  }): Promise<SyncJobRecord> {
    const count = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncJobs)
      .where(eq(syncJobs.organizationId, input.organizationId));
    if ((count[0]?.count ?? 0) >= ORG_QUOTAS.syncJobs) {
      throw unprocessable(`This organization already has the maximum of ${ORG_QUOTAS.syncJobs} sync jobs.`);
    }

    const source = await this.requireOwnedConnection(input.organizationId, input.sourceConnectionId);
    const destination = await this.requireOwnedConnection(
      input.organizationId,
      input.destinationConnectionId,
    );

    if (!supportsDestinationWrite(destination.provider)) {
      throw unprocessable(
        `The "${destination.name}" connector is a source only and cannot receive records. Choose a connection whose adapter supports an idempotent upsert.`,
      );
    }
    if (source.status === 'error') {
      throw unprocessable(
        `The source connection "${source.name}" is in an error state. Fix it and run a successful test first.`,
      );
    }
    if (!CONFLICT_POLICIES.includes(input.conflictPolicy as ConflictPolicy)) {
      throw badRequest('Choose an explicit conflict policy.', {
        conflictPolicy: ['Unsupported conflict policy'],
      });
    }
    if (!isValidTimeZone(input.timezone)) {
      throw badRequest('Choose a valid IANA timezone.', { timezone: ['Unknown timezone'] });
    }
    if (input.batchSize > ORG_QUOTAS.batchSizeMax) {
      throw badRequest(`Batch size cannot exceed ${ORG_QUOTAS.batchSizeMax}.`);
    }
    if (input.scheduleCron && !SyncJobService.isValidCron(input.scheduleCron)) {
      throw badRequest(
        'That cron expression is not supported. Use five fields with *, a number, a-b range, or */step, for example "*/15 * * * *".',
        { scheduleCron: ['Unsupported cron expression'] },
      );
    }

    const job = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(syncJobs)
        .values({
          organizationId: input.organizationId,
          name: input.name.trim(),
          sourceConnectionId: input.sourceConnectionId,
          destinationConnectionId: input.destinationConnectionId,
          sourceEntity: input.sourceEntity,
          destinationEntity: input.destinationEntity,
          mode: 'one_way',
          scheduleCron: input.scheduleCron,
          timezone: input.timezone,
          // Jobs always start paused.
          enabled: false,
          conflictPolicy: input.conflictPolicy,
          batchSize: input.batchSize,
          retryPolicy: input.retryPolicy,
          filters: input.filters,
          checkpoint: {},
          createdBy: input.actorUserId,
        })
        .returning();
      if (!inserted) throw new Error('Job insert returned no row');

      if (input.mappings.length > 0) {
        await tx.insert(syncMappings).values(
          input.mappings.map((mapping, index) => {
            const normalized = normalizeMapping(mapping);
            return {
              organizationId: input.organizationId,
              syncJobId: inserted.id,
              sourcePath: normalized.sourcePath,
              destinationPath: normalized.destinationPath,
              sourceType: normalized.sourceType,
              destinationType: normalized.destinationType,
              transformType: normalized.transformType,
              transformConfig: normalized.transformConfig,
              required: normalized.required,
              defaultValue: normalized.defaultValue ?? null,
              sortOrder: index,
            };
          }),
        );
      }
      return inserted;
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'sync_job.created',
      entityType: 'sync_job',
      entityId: job.id,
      metadata: {
        sourceConnectionId: input.sourceConnectionId,
        destinationConnectionId: input.destinationConnectionId,
        sourceEntity: input.sourceEntity,
        destinationEntity: input.destinationEntity,
        conflictPolicy: input.conflictPolicy,
        mappingCount: input.mappings.length,
        startedPaused: true,
      },
      requestId: input.requestId ?? null,
    });

    return job;
  }

  async update(input: {
    organizationId: string;
    jobId: string;
    actorUserId: string;
    patch: {
      name?: string;
      sourceEntity?: string;
      destinationEntity?: string;
      conflictPolicy?: string;
      scheduleCron?: string | null;
      timezone?: string;
      batchSize?: number;
      retryPolicy?: { mode: string; maxAttempts: number; backoffSeconds: number };
      filters?: Array<{ field: string; operator: string; value?: unknown }>;
    };
    requestId?: string | null;
  }): Promise<SyncJobRecord> {
    const current = await this.requireOwned(input.organizationId, input.jobId);
    if (input.patch.timezone && !isValidTimeZone(input.patch.timezone)) {
      throw badRequest('Choose a valid IANA timezone.', { timezone: ['Unknown timezone'] });
    }
    if (input.patch.conflictPolicy && !CONFLICT_POLICIES.includes(input.patch.conflictPolicy as ConflictPolicy)) {
      throw badRequest('Choose an explicit conflict policy.', {
        conflictPolicy: ['Unsupported conflict policy'],
      });
    }
    if (input.patch.scheduleCron && !SyncJobService.isValidCron(input.patch.scheduleCron)) {
      throw badRequest(
        'That cron expression is not supported. Use five fields with *, a number, a-b range, or */step, for example "*/15 * * * *".',
        { scheduleCron: ['Unsupported cron expression'] },
      );
    }

    const [updated] = await this.db
      .update(syncJobs)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(and(eq(syncJobs.id, current.id), eq(syncJobs.organizationId, input.organizationId)))
      .returning();
    if (!updated) throw notFound('Sync job');

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'sync_job.updated',
      entityType: 'sync_job',
      entityId: current.id,
      metadata: { fields: Object.keys(input.patch) },
      requestId: input.requestId ?? null,
    });
    return updated;
  }

  async setEnabled(input: {
    organizationId: string;
    jobId: string;
    actorUserId: string;
    enabled: boolean;
    requestId?: string | null;
  }): Promise<SyncJobRecord> {
    const current = await this.requireOwned(input.organizationId, input.jobId);

    if (input.enabled) {
      const mappings = await this.mappingsFor(input.organizationId, input.jobId);
      if (mappings.length === 0) {
        throw unprocessable('Add at least one field mapping before enabling this job.');
      }
      const destination = await this.requireOwnedConnection(
        input.organizationId,
        current.destinationConnectionId,
      );
      if (!supportsDestinationWrite(destination.provider)) {
        throw unprocessable(
          'The destination connector cannot perform an idempotent upsert, so this job cannot be enabled.',
        );
      }
    }

    const [updated] = await this.db
      .update(syncJobs)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(and(eq(syncJobs.id, current.id), eq(syncJobs.organizationId, input.organizationId)))
      .returning();
    if (!updated) throw notFound('Sync job');

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.enabled ? 'sync_job.enabled' : 'sync_job.paused',
      entityType: 'sync_job',
      entityId: current.id,
      metadata: { previousState: current.enabled ? 'enabled' : 'paused' },
      requestId: input.requestId ?? null,
    });
    return updated;
  }

  async delete(organizationId: string, jobId: string, actorUserId: string): Promise<void> {
    const current = await this.requireOwned(organizationId, jobId);
    const running = await this.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.syncJobId, current.id),
          inArray(syncRuns.status, ['running', 'queued']),
        ),
      )
      .limit(1);
    if (running[0]) {
      throw conflict('This job has a run in progress. Wait for it to finish before deleting.', {
        runId: running[0].id,
      });
    }
    await this.db.delete(syncJobs).where(and(eq(syncJobs.id, current.id), eq(syncJobs.organizationId, organizationId)));
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'sync_job.deleted',
      entityType: 'sync_job',
      entityId: current.id,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async requireOwned(organizationId: string, jobId: string): Promise<SyncJobRecord> {
    const rows = await this.db
      .select()
      .from(syncJobs)
      .where(and(eq(syncJobs.id, jobId), eq(syncJobs.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Sync job');
    return row;
  }

  async list(
    organizationId: string,
    query: { page: number; pageSize: number; q?: string; status?: string; sort: string; order: 'asc' | 'desc' },
  ): Promise<{ items: SyncJobRecord[]; total: number }> {
    const filters = [eq(syncJobs.organizationId, organizationId)];
    if (query.status && query.status !== 'all') {
      filters.push(query.status === 'paused' ? eq(syncJobs.enabled, false) : eq(syncJobs.enabled, true));
    }
    if (query.q) {
      const pattern = `%${query.q.toLowerCase()}%`;
      filters.push(sql`lower(${syncJobs.name}) like ${pattern}`);
    }
    const where = and(...filters);
    const sortColumn =
      query.sort === 'created_at' ? syncJobs.createdAt : query.sort === 'last_run_at' ? syncJobs.updatedAt : syncJobs.name;
    const direction = query.order === 'asc' ? asc : desc;

    const rows = await this.db
      .select()
      .from(syncJobs)
      .where(where)
      .orderBy(direction(sortColumn), asc(syncJobs.name))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const counts = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncJobs)
      .where(where);
    return { items: rows, total: counts[0]?.count ?? 0 };
  }

  async enabledJobs(): Promise<SyncJobRecord[]> {
    return this.db.select().from(syncJobs).where(eq(syncJobs.enabled, true));
  }

  async mappingsFor(organizationId: string, jobId: string) {
    return this.db
      .select()
      .from(syncMappings)
      .where(and(eq(syncMappings.syncJobId, jobId), eq(syncMappings.organizationId, organizationId)))
      .orderBy(asc(syncMappings.sortOrder));
  }

  /** Replaces the whole mapping set in one transaction, then re-validates. */
  async replaceMappings(input: {
    organizationId: string;
    jobId: string;
    actorUserId: string;
    mappings: Array<ReturnType<typeof assertMappingInput>>;
    requestId?: string | null;
  }): Promise<{ mappings: typeof syncMappings.$inferSelect[]; validation: MappingValidationResult }> {
    const job = await this.requireOwned(input.organizationId, input.jobId);
    const validation = validateMappings({ mappings: input.mappings });
    if (!validation.valid) {
      throw unprocessable(
        'The mapping set is not valid, so it was not saved.',
        Object.fromEntries(
          validation.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => [issue.destinationPath, [issue.message]]),
        ),
      );
    }

    const rows = await this.db.transaction(async (tx) => {
      await tx
        .delete(syncMappings)
        .where(and(eq(syncMappings.syncJobId, job.id), eq(syncMappings.organizationId, input.organizationId)));
      if (input.mappings.length === 0) return [];
      return tx
        .insert(syncMappings)
        .values(
          input.mappings.map((mapping, index) => {
            const normalized = normalizeMapping(mapping);
            return {
              organizationId: input.organizationId,
              syncJobId: job.id,
              sourcePath: normalized.sourcePath,
              destinationPath: normalized.destinationPath,
              sourceType: normalized.sourceType,
              destinationType: normalized.destinationType,
              transformType: normalized.transformType,
              transformConfig: normalized.transformConfig,
              required: normalized.required,
              defaultValue: normalized.defaultValue ?? null,
              sortOrder: index,
            };
          }),
        )
        .returning();
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'sync_job.mappings_replaced',
      entityType: 'sync_job',
      entityId: job.id,
      metadata: { count: rows.length, warnings: validation.issues.filter((i) => i.severity === 'warning').length },
      requestId: input.requestId ?? null,
    });

    return { mappings: rows, validation };
  }

  async validateMappingsOnly(input: {
    organizationId: string;
    jobId: string;
    mappings: Array<ReturnType<typeof assertMappingInput>>;
    sampleSourceFields?: string[];
  }): Promise<MappingValidationResult> {
    await this.requireOwned(input.organizationId, input.jobId);
    return validateMappings({
      mappings: input.mappings,
      ...(input.sampleSourceFields ? { sampleSourceFields: input.sampleSourceFields } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Dashboard shaping                                                       */
  /* ---------------------------------------------------------------------- */

  async toListItem(job: SyncJobRecord, windowLabel: string): Promise<SyncJobListItem> {
    const [source, destination] = await Promise.all([
      this.db
        .select({ name: connections.name })
        .from(connections)
        .where(eq(connections.id, job.sourceConnectionId))
        .limit(1),
      this.db
        .select({ name: connections.name })
        .from(connections)
        .where(eq(connections.id, job.destinationConnectionId))
        .limit(1),
    ]);

    const lastRunRows = await this.db
      .select({
        id: syncRuns.id,
        status: syncRuns.status,
        triggerType: syncRuns.triggerType,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        durationMs: syncRuns.durationMs,
        fetchedCount: syncRuns.fetchedCount,
        createdCount: syncRuns.createdCount,
        updatedCount: syncRuns.updatedCount,
        skippedCount: syncRuns.skippedCount,
        failedCount: syncRuns.failedCount,
        errorCode: syncRuns.errorCode,
        safeMessage: syncRuns.safeMessage,
      })
      .from(syncRuns)
      .where(and(eq(syncRuns.syncJobId, job.id), sql`${syncRuns.dryRun} = false`))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);

    const rateRows = await this.db
      .select({ status: syncRuns.status, count: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(and(eq(syncRuns.syncJobId, job.id), sql`${syncRuns.dryRun} = false`))
      .groupBy(syncRuns.status);

    const successfulRuns = rateRows.find((row) => row.status === 'succeeded')?.count ?? 0;
    const partialRuns = rateRows.find((row) => row.status === 'partial')?.count ?? 0;
    const failedRuns =
      (rateRows.find((row) => row.status === 'failed')?.count ?? 0) +
      (rateRows.find((row) => row.status === 'cancelled')?.count ?? 0);
    const totalRuns = rateRows.reduce((sum, row) => sum + row.count, 0);

    const openIssues = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncIssues)
      .where(and(eq(syncIssues.syncJobId, job.id), inArray(syncIssues.status, ['open', 'retrying'])));
    const openIssueCount = openIssues[0]?.count ?? 0;

    const driftRows = await this.db
      .select({ id: syncIssues.id, lastSeenAt: syncIssues.lastSeenAt })
      .from(syncIssues)
      .where(
        and(
          eq(syncIssues.syncJobId, job.id),
          eq(syncIssues.issueType, 'schema_drift'),
          inArray(syncIssues.status, ['open', 'retrying']),
        ),
      )
      .limit(1);

    return {
      id: job.id,
      name: job.name,
      sourceConnectionId: job.sourceConnectionId,
      sourceConnectionName: source[0]?.name ?? '(removed connection)',
      destinationConnectionId: job.destinationConnectionId,
      destinationConnectionName: destination[0]?.name ?? '(removed connection)',
      sourceEntity: job.sourceEntity,
      destinationEntity: job.destinationEntity,
      mode: 'one_way',
      scheduleCron: job.scheduleCron,
      timezone: job.timezone,
      status: job.enabled ? 'enabled' : 'paused',
      conflictPolicy: job.conflictPolicy as ConflictPolicy,
      batchSize: job.batchSize,
      lastRun: lastRunRows[0]
        ? {
            id: lastRunRows[0].id,
            status: lastRunRows[0].status as RunStatus,
            trigger: lastRunRows[0].triggerType as RunTrigger,
            startedAt: lastRunRows[0].startedAt.toISOString(),
            finishedAt: lastRunRows[0].finishedAt?.toISOString() ?? null,
            durationMs: lastRunRows[0].durationMs,
            fetchedCount: lastRunRows[0].fetchedCount,
            createdCount: lastRunRows[0].createdCount,
            updatedCount: lastRunRows[0].updatedCount,
            skippedCount: lastRunRows[0].skippedCount,
            failedCount: lastRunRows[0].failedCount,
            errorCode: lastRunRows[0].errorCode,
            safeMessage: lastRunRows[0].safeMessage,
          }
        : null,
      successRate: {
        successfulRuns,
        failedRuns,
        partialRuns,
        totalRuns,
        windowLabel,
        successRatePercent: totalRuns === 0 ? null : (successfulRuns / totalRuns) * 100,
      },
      openIssueCount,
      schemaDrift: {
        detected: Boolean(driftRows[0]),
        unknownSourceFields: [],
        lastDetectedAt: driftRows[0]?.lastSeenAt.toISOString() ?? null,
        lastRunId: null,
      },
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  async openIssueCounts(organizationId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ syncJobId: syncIssues.syncJobId, count: sql<number>`count(*)::int` })
      .from(syncIssues)
      .where(
        and(eq(syncIssues.organizationId, organizationId), inArray(syncIssues.status, ['open', 'retrying'])),
      )
      .groupBy(syncIssues.syncJobId);
    return new Map(rows.map((row) => [row.syncJobId, row.count]));
  }

  async recordsForJob(organizationId: string, jobId: string, limit = 50) {
    return this.db
      .select()
      .from(syncRecords)
      .where(and(eq(syncRecords.organizationId, organizationId), eq(syncRecords.syncJobId, jobId)))
      .orderBy(desc(syncRecords.updatedAt))
      .limit(Math.min(limit, 200));
  }

  /**
   * Paginated run history for one job. Dry runs are included but clearly
   * labelled, because a dry run is real evidence about what would happen.
   */
  async listRuns(
    organizationId: string,
    jobId: string,
    query: {
      page: number;
      pageSize: number;
      status: string;
      trigger: string;
      sort: string;
      order: 'asc' | 'desc';
    },
  ) {
    const filters = [eq(syncRuns.organizationId, organizationId), eq(syncRuns.syncJobId, jobId)];
    if (query.status && query.status !== 'all') filters.push(eq(syncRuns.status, query.status));
    if (query.trigger && query.trigger !== 'all') filters.push(eq(syncRuns.triggerType, query.trigger));
    const where = and(...filters);

    const sortColumn =
      query.sort === 'finished_at'
        ? syncRuns.finishedAt
        : query.sort === 'duration_ms'
          ? syncRuns.durationMs
          : syncRuns.startedAt;
    const direction = query.order === 'asc' ? asc : desc;

    const rows = await this.db
      .select()
      .from(syncRuns)
      .where(where)
      .orderBy(direction(sortColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const totals = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(where);
    const total = totals[0]?.count ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.id,
        syncJobId: row.syncJobId,
        trigger: row.triggerType,
        status: row.status as never,
        dryRun: row.dryRun,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: row.durationMs,
        fetchedCount: row.fetchedCount,
        createdCount: row.createdCount,
        updatedCount: row.updatedCount,
        skippedCount: row.skippedCount,
        failedCount: row.failedCount,
        errorCode: row.errorCode,
        safeMessage: row.safeMessage,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * Transforms sample records with the stored mappings. The input is always
   * labelled in the UI as a local development fixture: this method NEVER calls
   * a source adapter and NEVER performs a destination write.
   */
  previewTransforms(input: {
    mappings: Array<ReturnType<typeof normalizeMapping>>;
    fixture: Array<Record<string, unknown>>;
  }) {
    const rows = input.fixture.slice(0, 25).map((source, index) => {
      const destination: Record<string, unknown> = {};
      const errors: Array<{ destinationPath: string; message: string }> = [];
      const covered = new Set<string>();

      for (const mapping of input.mappings) {
        covered.add(mapping.sourcePath);
        const result = applyMapping(source, mapping);
        if (!result.ok) {
          errors.push({
            destinationPath: mapping.destinationPath,
            message: result.message ?? 'Transform failed.',
          });
          continue;
        }
        let value = result.value;
        if (value === null || value === undefined) {
          if (mapping.defaultValue !== undefined && mapping.defaultValue !== null) {
            value = mapping.defaultValue;
          } else if (mapping.required) {
            errors.push({
              destinationPath: mapping.destinationPath,
              message: 'Required destination field is empty and has no default.',
            });
            continue;
          } else {
            continue;
          }
        }
        writePath(destination, mapping.destinationPath, value);
      }

      const unmappedSourceFields = Object.keys(source).filter((key) => !covered.has(key));
      return { index, destination, errors, unmappedSourceFields };
    });

    return {
      fixtureSource: 'local_development_fixture' as const,
      notice:
        'These records come from the local development fixture supplied with this request. No connection was called and no destination write was performed.',
      mappings: input.mappings.map((mapping) => ({
        sourcePath: mapping.sourcePath,
        destinationPath: mapping.destinationPath,
        destinationType: mapping.destinationType,
        transformType: mapping.transformType,
        required: mapping.required,
      })),
      rows,
      destinationWrites: 0,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async requireOwnedConnection(organizationId: string, connectionId: string) {
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Connection');
    return row;
  }

  /**
   * Minimal cron matcher used by the scheduler. It intentionally supports the
   * common subset (asterisk, step values such as every-n, ranges and plain
   * numbers or comma separated lists) evaluated in UTC minutes. Anything outside
   * the subset is rejected at save time rather than silently never running.
   */
  static cronMatches(expression: string, at: Date): boolean {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
    const values = [
      at.getUTCMinutes(),
      at.getUTCHours(),
      at.getUTCDate(),
      at.getUTCMonth() + 1,
      at.getUTCDay(),
    ];
    const fieldsChecked = [minute, hour, dayOfMonth, month, dayOfWeek];
    for (let index = 0; index < 5; index += 1) {
      if (!matchesCronField(fieldsChecked[index]!, values[index]!)) return false;
    }
    return true;
  }

  static isValidCron(expression: string): boolean {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const ranges: Array<[number, number]> = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ];
    return fields.every((field, index) => {
      const [min, max] = ranges[index]!;
      if (field === '*') return true;
      return field.split(',').every((part) => {
        const step = part.split('/');
        const range = step[0]!;
        const stepValue = step[1];
        if (stepValue !== undefined && !/^\d+$/.test(stepValue)) return false;
        if (range === '*') return true;
        if (/^\d+$/.test(range)) {
          const value = Number(range);
          return value >= min && value <= max;
        }
        const span = /^(\d+)-(\d+)$/.exec(range);
        if (!span) return false;
        const start = Number(span[1]);
        const end = Number(span[2]);
        return start >= min && end <= max && start <= end;
      });
    });
  }
}

function matchesCronField(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (!rangePart) continue;
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step < 1) continue;

    if (rangePart === '*') {
      // `*/n` with the current value determines the match.
      if (value % step === 0) return true;
      continue;
    }
    if (/^\d+$/.test(rangePart)) {
      if (Number(rangePart) === value) return true;
      continue;
    }
    const span = /^(\d+)-(\d+)$/.exec(rangePart);
    if (!span) continue;
    const start = Number(span[1]);
    const end = Number(span[2]);
    if (value < start || value > end) continue;
    if (step === 1) return true;
    if ((value - start) % step === 0) return true;
  }
  return false;
}

/** True when a webhook event or record row exists for the job (used by tests). */
export function jobHasRecords(rows: Array<{ lastSyncedAt: Date | null }>): boolean {
  return rows.some((row) => row.lastSyncedAt !== null);
}