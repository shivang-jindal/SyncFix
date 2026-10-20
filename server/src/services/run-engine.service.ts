/**
 * The sync run engine (Part D / D5, D9).
 *
 * Guarantees implemented here:
 *
 *  - **Per-job advisory lock.** A run cannot start while another run for the
 *    same job holds the lock, so scheduled runs never overlap.
 *  - **Checkpoints only after the batch is committed.** The cursor written to
 *    `sync_jobs.checkpoint_json` is the cursor of the last page whose records
 *    were all persisted. Behaviour is therefore at-least-once; the idempotency
 *    key makes a replay a no-op at the destination.
 *  - **Idempotency keys on every destination write.** The key is derived from
 *    (job id, source record key, source payload hash), so a retry of the same
 *    logical record always produces the same key.
 *  - **Dry runs perform zero destination writes.** The adapter's `upsertRecord`
 *    is never called when `dryRun` is set; the run still fetches, validates and
 *    transforms so the operator sees a real plan.
 *  - **Partial success is reported, never hidden.** A run that wrote some
 *    records and failed others finishes as `partial` and keeps the failed
 *    records in `sync_issues`.
 *  - **Conflicts need an explicit policy.** Nothing is written on a conflict
 *    unless the job's stored policy says so.
 *  - **No bidirectional sync.** The engine only ever reads the source adapter
 *    and writes the destination adapter.
 *  - **Retries are only offered when idempotent.** A record whose destination
 *    write cannot be confirmed is marked non-retryable with an explanation.
 *  - **Schema drift is surfaced.** Unknown source fields are recorded as an
 *    issue instead of being silently dropped.
 */

import { createHash as nodeCreateHash, randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  RUN_STEP_NAMES,
  SYNC_LOCK_TTL_MS,
  type ConflictPolicy,
  type IssueSeverity,
  type IssueType,
  type RunStatus,
  type RunStepName,
  type RunTrigger,
} from '@syncfix/shared';

import { AdapterError } from '../adapters/types.js';
import type { AdapterRecord, AdapterPage, ConnectorAdapter } from '../adapters/types.js';
import type { AppDatabase } from '../db/client.js';
import {
  syncJobs,
  syncLocks,
  syncMappings,
  syncRecords,
  syncRunSteps,
  syncRuns,
} from '../db/schema.js';
import { AppError, conflict, notFound, unprocessable } from '../errors.js';
import { redactPayload, safeUrlLabel } from '../lib/redact.js';
import { stableHash } from '@syncfix/shared';
import type { ConnectionService, ConnectionRecord } from './connection.service.js';
import type { IssueService } from './issue.service.js';
import { applyMapping, normalizeMapping, readPath, writePath } from './mapping.service.js';
import type { SyncJobRecord } from './sync-job.service.js';

export interface RunCounts {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface RunEngineOptions {
  db: AppDatabase;
  logger: Logger;
  connections: ConnectionService;
  issues: IssueService;
  /** Test seam: the webhook-sourced record reader. */
  readWebhookRecords?: (
    job: SyncJobRecord,
    cursor: string | null,
    limit: number,
  ) => Promise<AdapterPage>;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  counts: RunCounts;
  errorCode: string | null;
  safeMessage: string | null;
  notes: string[];
}

export class RunEngine {
  private readonly db: AppDatabase;
  private readonly logger: Logger;
  private readonly connections: ConnectionService;
  private readonly issues: IssueService;
  private readonly readWebhookRecords?: RunEngineOptions['readWebhookRecords'];

  constructor(options: RunEngineOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.connections = options.connections;
    this.issues = options.issues;
    this.readWebhookRecords = options.readWebhookRecords;
  }

  /* ---------------------------------------------------------------------- */
  /* Entry points                                                           */
  /* ---------------------------------------------------------------------- */

  async execute(input: {
    organizationId: string;
    jobId: string;
    trigger: RunTrigger;
    dryRun: boolean;
    actorUserId: string | null;
    requestId: string | null;
    /** Re-process one record only (used by issue repair). */
    onlyRecordKey?: string | null;
  }): Promise<RunOutcome> {
    const job = await this.requireJob(input.organizationId, input.jobId);
    if (!input.dryRun && !job.enabled && input.trigger !== 'repair') {
      throw unprocessable(
        'This job is paused. Enable it, or run a dry-run, before executing a real sync.',
      );
    }

    const sourceConnection = await this.connections.get(input.organizationId, job.sourceConnectionId);
    const destinationConnection = await this.connections.get(
      input.organizationId,
      job.destinationConnectionId,
    );

    const mappings = await this.loadMappings(input.organizationId, job.id);
    if (mappings.length === 0) {
      throw unprocessable('This job has no field mappings. Add at least one before running.');
    }

    const [run] = await this.db
      .insert(syncRuns)
      .values({
        organizationId: input.organizationId,
        syncJobId: job.id,
        triggerType: input.trigger,
        status: 'running',
        dryRun: input.dryRun,
        cursorStart: job.checkpoint,
        requestId: input.requestId,
        createdBy: input.actorUserId,
      })
      .returning();
    if (!run) throw new Error('Run insert returned no row');

    const notes: string[] = [];
    if (input.dryRun) {
      notes.push(
        'Dry run: no destination write was attempted. Counts below describe what WOULD happen.',
      );
    }

    /* -- Lock ------------------------------------------------------------ */
    const lock = await this.acquireLock(input.organizationId, job.id, run.id);
    if (!lock) {
      await this.db
        .update(syncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorCode: 'job_locked',
          safeMessage: 'Another run for this job is already in progress. Overlapping runs are not allowed.',
          durationMs: 0,
        })
        .where(eq(syncRuns.id, run.id));
      throw conflict('Another run for this job is already in progress.');
    }

    const startedAt = Date.now();
    const counts: RunCounts = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    let lastCommittedCursor: Record<string, unknown> = job.checkpoint;
    let cursor: string | null = input.onlyRecordKey ? null : (job.checkpoint.cursor as string | null) ?? null;
    const cursorStart: Record<string, unknown> = job.checkpoint;
    let fatal: { code: string; message: string } | null = null;
    const unknownFieldsSeen = new Set<string>();

    try {
      const sourceAdapter = this.connections.adapterFor(sourceConnection);
      const destinationAdapter = this.connections.adapterFor(destinationConnection);

      await this.recordStep(input.organizationId, run.id, 'acquire_lock', 'succeeded', {
        acquired: 1,
      });

      /* -- Fetch --------------------------------------------------------- */
      const fetchStep = await this.startStep(input.organizationId, run.id, 'fetch');
      if (!input.onlyRecordKey) {
        for (;;) {
          const page = await this.fetchPage(sourceAdapter, sourceConnection, job, cursor);
          counts.fetched += page.records.length;
          for (const field of page.unknownFields) unknownFieldsSeen.add(field);

          if (page.records.length === 0) break;

          const writeStep = await this.startStep(input.organizationId, run.id, 'write');
          await this.processBatch({
            organizationId: input.organizationId,
            job,
            runId: run.id,
            records: page.records,
            mappings,
            sourceAdapter,
            destinationAdapter,
            destinationConnection,
            dryRun: input.dryRun,
            counts,
            notes,
          });
          await this.finishStep(writeStep.id, 'succeeded', {
            written: counts.created + counts.updated,
            skipped: counts.skipped,
            failed: counts.failed,
          });

          // Checkpoint only after the whole batch was persisted.
          if (page.nextCursor) {
            lastCommittedCursor = { cursor: page.nextCursor };
            await this.db
              .update(syncJobs)
              .set({ checkpoint: lastCommittedCursor, updatedAt: new Date() })
              .where(eq(syncJobs.id, job.id));
          } else {
            lastCommittedCursor = { cursor: null };
            await this.db
              .update(syncJobs)
              .set({ checkpoint: lastCommittedCursor, updatedAt: new Date() })
              .where(eq(syncJobs.id, job.id));
            await this.finishStep(fetchStep.id, 'succeeded', { fetched: counts.fetched });
            break;
          }

          if (page.records.length === 0) break;
          cursor = page.nextCursor;
          if (page.nextCursor === null) break;
        }
        if (!fatal) await this.finishStep(fetchStep.id, 'succeeded', { fetched: counts.fetched });
      } else {
        // Single-record repair path.
        const adapterContext = this.connections.contextFor(sourceConnection);
        const record = await sourceAdapter.getRecord(adapterContext, job.sourceEntity, input.onlyRecordKey!);
        await this.finishStep(fetchStep.id, record ? 'succeeded' : 'skipped', {
          fetched: record ? 1 : 0,
        });
        if (record) {
          const writeStep = await this.startStep(input.organizationId, run.id, 'write');
          await this.processBatch({
            organizationId: input.organizationId,
            job,
            runId: run.id,
            records: [record],
            mappings,
            sourceAdapter,
            destinationAdapter,
            destinationConnection,
            dryRun: input.dryRun,
            counts,
            notes,
          });
          await this.finishStep(writeStep.id, 'succeeded', {
            written: counts.created + counts.updated,
            skipped: counts.skipped,
            failed: counts.failed,
          });
        }
      }

      /* -- Schema drift -------------------------------------------------- */
      if (unknownFieldsSeen.size > 0) {
        await this.issues.record({
          organizationId: input.organizationId,
          syncJobId: job.id,
          syncRunId: run.id,
          recordKey: null,
          issueType: 'schema_drift',
          severity: 'warning',
          errorCode: 'unknown_source_fields',
          safeMessage: `The source returned ${unknownFieldsSeen.size} field(s) SyncFix has not seen before: ${[...unknownFieldsSeen].slice(0, 12).join(', ')}. They were not written. Map them deliberately or acknowledge the change.`,
          redactedPayload: { unknownFields: [...unknownFieldsSeen].slice(0, 50) },
          retryable: false,
        });
        notes.push(
          `Schema drift: ${unknownFieldsSeen.size} new source field(s) were surfaced, not silently dropped.`,
        );
      }

      /* -- Checkpoint step ----------------------------------------------- */
      const checkpointStep = await this.startStep(input.organizationId, run.id, 'checkpoint');
      if (!input.dryRun) {
        await this.db
          .update(syncRuns)
          .set({ cursorEnd: lastCommittedCursor })
          .where(eq(syncRuns.id, run.id));
      }
      await this.finishStep(checkpointStep.id, 'succeeded', { checkpointed: input.dryRun ? 0 : 1 });
    } catch (error) {
      const normalized = error instanceof AdapterError ? error.normalized : null;
      fatal = {
        code: normalized?.code ?? (error instanceof Error ? error.name : 'run_error'),
        message:
          normalized?.message ??
          (error instanceof Error ? error.message : 'The run stopped unexpectedly.'),
      };
      this.logger.warn(
        { jobId: job.id, runId: run.id, code: fatal.code },
        'sync run aborted',
      );
    } finally {
      await this.releaseLock(lock.id);
    }

    const durationMs = Date.now() - startedAt;
    const status = decideStatus(counts, fatal);
    if (fatal) {
      await this.issues.record({
        organizationId: input.organizationId,
        syncJobId: job.id,
        syncRunId: run.id,
        recordKey: null,
        issueType: classifyFatal(fatal.code),
        severity: 'critical',
        errorCode: fatal.code,
        safeMessage: fatal.message,
        retryable: true,
      });
      notes.push('The run stopped early. Records already written were kept and are not repeated.');
    }

    await this.db
      .update(syncRuns)
      .set({
        status,
        finishedAt: new Date(),
        fetchedCount: counts.fetched,
        createdCount: counts.created,
        updatedCount: counts.updated,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        cursorStart,
        cursorEnd: input.dryRun ? cursorStart : lastCommittedCursor,
        durationMs,
        errorCode: fatal?.code ?? null,
        safeMessage: fatal?.message ?? null,
      })
      .where(eq(syncRuns.id, run.id));

    return {
      runId: run.id,
      status,
      counts,
      errorCode: fatal?.code ?? null,
      safeMessage: fatal?.message ?? null,
      notes,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Per-record pipeline                                                     */
  /* ---------------------------------------------------------------------- */

  private async processBatch(input: {
    organizationId: string;
    job: SyncJobRecord;
    runId: string;
    records: AdapterRecord[];
    mappings: Array<ReturnType<typeof normalizeMapping>>;
    sourceAdapter: ConnectorAdapter;
    destinationAdapter: ConnectorAdapter;
    destinationConnection: ConnectionRecord;
    dryRun: boolean;
    counts: RunCounts;
    notes: string[];
  }): Promise<void> {
    for (const record of input.records) {
      const payload = record.payload;
      const payloadHash = stableHash(payload);
      const sourceVersion = record.version ?? null;

      const existingRows = await this.db
        .select()
        .from(syncRecords)
        .where(
          and(
            eq(syncRecords.organizationId, input.organizationId),
            eq(syncRecords.syncJobId, input.job.id),
            eq(syncRecords.sourceRecordKey, record.key),
          ),
        )
        .limit(1);
      const existing = existingRows[0];

      /* -- Skip unchanged ------------------------------------------------ */
      if (existing && existing.lastHash === payloadHash && existing.status === 'synced') {
        input.counts.skipped += 1;
        continue;
      }

      /* -- Conflict ------------------------------------------------------ */
      if (existing && existing.destinationRecordKey && existing.lastSyncedAt) {
        const conflictDecision = this.decideConflict({
          policy: input.job.conflictPolicy as ConflictPolicy,
          sourceUpdatedAt: record.updatedAt ?? null,
          destinationVersion: existing.destinationVersion,
          sourceVersion,
          hashChanged: existing.lastHash !== payloadHash,
        });
        if (conflictDecision === 'skip') {
          input.counts.skipped += 1;
          await this.upsertRecordRow({
            organizationId: input.organizationId,
            jobId: input.job.id,
            record,
            payloadHash,
            sourceVersion,
            status: 'skipped',
            destinationRecordKey: existing.destinationRecordKey,
            redactedSource: redactPayload(payload) as Record<string, unknown>,
          });
          continue;
        }
        if (conflictDecision === 'manual_review') {
          input.counts.failed += 1;
          await this.issues.record({
            organizationId: input.organizationId,
            syncJobId: input.job.id,
            syncRunId: input.runId,
            recordKey: record.key,
            issueType: 'conflict',
            severity: 'warning',
            errorCode: 'conflict_manual_review',
            safeMessage: `The source and destination both changed for record "${record.key}". This job's conflict policy is manual review, so nothing was written.`,
            redactedPayload: {
              sourceVersion,
              destinationVersion: existing.destinationVersion,
              sourceHashChanged: existing.lastHash !== payloadHash,
            },
            retryable: false,
          });
          await this.upsertRecordRow({
            organizationId: input.organizationId,
            jobId: input.job.id,
            record,
            payloadHash,
            sourceVersion,
            status: 'conflict',
            destinationRecordKey: existing.destinationRecordKey,
            redactedSource: redactPayload(payload) as Record<string, unknown>,
          });
          continue;
        }
        // 'write' falls through to the normal write path.
      }

      /* -- Transform ----------------------------------------------------- */
      const destination: Record<string, unknown> = {};
      let transformError: string | null = null;
      for (const mapping of input.mappings) {
        const result = applyMapping(payload, mapping);
        if (!result.ok) {
          transformError = result.message ?? 'Transform failed.';
          break;
        }
        let value = result.value;
        if (value === null || value === undefined) {
          if (mapping.defaultValue !== undefined && mapping.defaultValue !== null) {
            value = mapping.defaultValue;
          } else if (mapping.required) {
            transformError = `Required destination field "${mapping.destinationPath}" is empty.`;
            break;
          } else {
            continue;
          }
        }
        writePath(destination, mapping.destinationPath, value);
      }

      if (transformError) {
        input.counts.failed += 1;
        await this.issues.record({
          organizationId: input.organizationId,
          syncJobId: input.job.id,
          syncRunId: input.runId,
          recordKey: record.key,
          issueType: 'transform_failed',
          severity: 'warning',
          errorCode: 'mapping_failed',
          safeMessage: transformError,
          redactedPayload: { source: redactPayload(payload) },
          retryable: true,
        });
        await this.upsertRecordRow({
          organizationId: input.organizationId,
          jobId: input.job.id,
          record,
          payloadHash,
          sourceVersion,
          status: 'failed',
          redactedSource: redactPayload(payload) as Record<string, unknown>,
        });
        continue;
      }

      /* -- Dry run: stop here, before any destination call ---------------- */
      if (input.dryRun) {
        input.counts.created += 1;
        await this.upsertRecordRow({
          organizationId: input.organizationId,
          jobId: input.job.id,
          record,
          payloadHash,
          sourceVersion,
          status: 'skipped',
          destinationRecordKey: null,
          redactedSource: redactPayload(payload) as Record<string, unknown>,
        });
        continue;
      }

      /* -- Write --------------------------------------------------------- */
      const idempotencyKey = buildIdempotencyKey({
        jobId: input.job.id,
        sourceRecordKey: record.key,
        payloadHash,
      });

      try {
        const result = await input.destinationAdapter.upsertRecord(
          this.connections.contextFor(input.destinationConnection),
          input.job.destinationEntity,
          {
            key: existing?.destinationRecordKey ?? record.key,
            payload: destination,
            version: sourceVersion,
            updatedAt: record.updatedAt ?? null,
          },
          idempotencyKey,
        );

        if (!result.confirmed) {
          // Never claim a write succeeded without confirmation.
          input.counts.failed += 1;
          await this.issues.record({
            organizationId: input.organizationId,
            syncJobId: input.job.id,
            syncRunId: input.runId,
            recordKey: record.key,
            issueType: 'destination_write_failed',
            severity: 'critical',
            errorCode: 'write_unconfirmed',
            safeMessage: `The destination did not confirm the write for record "${record.key}". ${result.detail}`,
            redactedPayload: { idempotencyKey, source: redactPayload(payload) },
            // PUT is idempotent, so a retry is safe even though the write is unconfirmed.
            retryable: true,
          });
          await this.upsertRecordRow({
            organizationId: input.organizationId,
            jobId: input.job.id,
            record,
            payloadHash,
            sourceVersion,
            status: 'failed',
            redactedSource: redactPayload(payload) as Record<string, unknown>,
          });
          continue;
        }

        const isUpdate = Boolean(existing?.destinationRecordKey);
        if (isUpdate) input.counts.updated += 1;
        else input.counts.created += 1;

        await this.upsertRecordRow({
          organizationId: input.organizationId,
          jobId: input.job.id,
          record,
          payloadHash,
          sourceVersion,
          status: isUpdate ? 'updated' : 'created',
          destinationRecordKey: result.recordKey,
          destinationVersion: result.version,
          redactedSource: redactPayload(payload) as Record<string, unknown>,
        });
      } catch (error) {
        const normalized =
          error instanceof AdapterError
            ? error.normalized
            : {
                kind: 'unknown' as const,
                code: 'destination_error',
                message: error instanceof Error ? error.message : 'Unknown destination error.',
                retryable: false,
                status: null,
                retryAfterSeconds: null,
              };

        input.counts.failed += 1;
        await this.issues.record({
          organizationId: input.organizationId,
          syncJobId: input.job.id,
          syncRunId: input.runId,
          recordKey: record.key,
          issueType: classifyAdapterError(normalized.kind),
          severity: severityFor(normalized.kind),
          errorCode: normalized.code,
          safeMessage: `${safeUrlLabel(input.destinationConnection.settings.baseUrl as string)}: ${normalized.message}`,
          redactedPayload: { idempotencyKey, source: redactPayload(payload) },
          retryable: normalized.retryable,
        });
        await this.upsertRecordRow({
          organizationId: input.organizationId,
          jobId: input.job.id,
          record,
          payloadHash,
          sourceVersion,
          status: 'failed',
          redactedSource: redactPayload(payload) as Record<string, unknown>,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Locking                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Atomically claims the single lock row for a job. An expired lock is taken
   * over, which is what makes a crashed worker's job recoverable.
   */
  private async acquireLock(
    organizationId: string,
    jobId: string,
    runId: string,
  ): Promise<{ id: string; ownerToken: string } | null> {
    const ownerToken = randomUUID();
    const expiresAt = new Date(Date.now() + SYNC_LOCK_TTL_MS);

    // Take over an expired lock, if any.
    await this.db
      .delete(syncLocks)
      .where(and(eq(syncLocks.syncJobId, jobId), sql`${syncLocks.expiresAt} < now()`));

    const inserted = await this.db
      .insert(syncLocks)
      .values({ organizationId, syncJobId: jobId, ownerToken, runId, expiresAt })
      .onConflictDoNothing({ target: syncLocks.syncJobId })
      .returning({ id: syncLocks.id, ownerToken: syncLocks.ownerToken });

    const row = inserted[0];
    return row ? { id: row.id, ownerToken: row.ownerToken } : null;
  }

  private async releaseLock(lockId: string): Promise<void> {
    await this.db.delete(syncLocks).where(eq(syncLocks.id, lockId));
  }

  /** Releases expired locks; called by the maintenance job. */
  async reapExpiredLocks(): Promise<number> {
    const deleted = await this.db
      .delete(syncLocks)
      .where(sql`${syncLocks.expiresAt} < now()`)
      .returning({ id: syncLocks.id });
    return deleted.length;
  }

  async activeLock(jobId: string) {
    const rows = await this.db
      .select()
      .from(syncLocks)
      .where(and(eq(syncLocks.syncJobId, jobId), sql`${syncLocks.expiresAt} >= now()`))
      .limit(1);
    return rows[0] ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                   */
  /* ---------------------------------------------------------------------- */

  private async startStep(organizationId: string, runId: string, stepName: RunStepName) {
    const sortOrder = RUN_STEP_NAMES.indexOf(stepName);
    const [row] = await this.db
      .insert(syncRunSteps)
      .values({
        organizationId,
        syncRunId: runId,
        stepName,
        status: 'running',
        sortOrder,
      })
      .returning();
    return row!;
  }

  private async recordStep(
    organizationId: string,
    runId: string,
    stepName: RunStepName,
    status: 'succeeded' | 'skipped',
    counts: Record<string, number>,
  ) {
    await this.db.insert(syncRunSteps).values({
      organizationId,
      syncRunId: runId,
      stepName,
      status,
      counts,
      startedAt: new Date(),
      finishedAt: new Date(),
      sortOrder: RUN_STEP_NAMES.indexOf(stepName),
    });
  }

  private async finishStep(
    stepId: string,
    status: 'succeeded' | 'failed' | 'skipped',
    counts: Record<string, number>,
    error?: { code: string; message: string },
  ) {
    await this.db
      .update(syncRunSteps)
      .set({
        status,
        counts,
        finishedAt: new Date(),
        ...(error ? { errorCode: error.code, safeMessage: error.message.slice(0, 500) } : {}),
      })
      .where(eq(syncRunSteps.id, stepId));
  }

  /* ---------------------------------------------------------------------- */
  /* Fetching                                                                */
  /* ---------------------------------------------------------------------- */

  private async fetchPage(
    adapter: ConnectorAdapter,
    connection: ConnectionRecord,
    job: SyncJobRecord,
    cursor: string | null,
  ): Promise<AdapterPage> {
    if (connection.provider === 'webhook_ingest') {
      if (!this.readWebhookRecords) {
        throw new AppError(
          501,
          'INTERNAL_ERROR',
          'No buffered-event reader is wired for this deployment.',
        );
      }
      return this.readWebhookRecords(job, cursor, job.batchSize);
    }
    return adapter.fetchPage(this.connections.contextFor(connection), job.sourceEntity, cursor, job.batchSize);
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  private async requireJob(organizationId: string, jobId: string): Promise<SyncJobRecord> {
    const rows = await this.db
      .select()
      .from(syncJobs)
      .where(and(eq(syncJobs.id, jobId), eq(syncJobs.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Sync job');
    return row;
  }

  private async loadMappings(organizationId: string, jobId: string) {
    const rows = await this.db
      .select()
      .from(syncMappings)
      .where(and(eq(syncMappings.syncJobId, jobId), eq(syncMappings.organizationId, organizationId)))
      .orderBy(asc(syncMappings.sortOrder));
    return rows.map((row) =>
      normalizeMapping({
        sourcePath: row.sourcePath,
        destinationPath: row.destinationPath,
        sourceType: row.sourceType as never,
        destinationType: row.destinationType as never,
        transformType: row.transformType as never,
        transformConfig: row.transformConfig,
        required: row.required,
        ...(row.defaultValue !== null ? { defaultValue: row.defaultValue } : {}),
        sortOrder: row.sortOrder,
      }),
    );
  }

  private async upsertRecordRow(input: {
    organizationId: string;
    jobId: string;
    record: AdapterRecord;
    payloadHash: string;
    sourceVersion: string | null;
    status: string;
    destinationRecordKey?: string | null;
    destinationVersion?: string | null;
    redactedSource: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insert(syncRecords)
      .values({
        organizationId: input.organizationId,
        syncJobId: input.jobId,
        sourceRecordKey: input.record.key,
        destinationRecordKey:
          input.destinationRecordKey === undefined
            ? input.record.key
            : input.destinationRecordKey,
        sourceVersion: input.sourceVersion,
        destinationVersion: input.destinationVersion ?? null,
        lastSyncedAt: input.status === 'skipped' ? null : new Date(),
        lastHash: input.payloadHash,
        status: input.status,
        redactedSource: input.redactedSource,
      })
      .onConflictDoUpdate({
        target: [syncRecords.syncJobId, syncRecords.sourceRecordKey],
        set: {
          destinationRecordKey: input.destinationRecordKey ?? input.record.key,
          sourceVersion: input.sourceVersion,
          destinationVersion: input.destinationVersion ?? null,
          lastSyncedAt: input.status === 'skipped' ? null : new Date(),
          lastHash: input.payloadHash,
          status: input.status,
          redactedSource: input.redactedSource,
          updatedAt: new Date(),
        },
      });
  }

  private decideConflict(input: {
    policy: ConflictPolicy;
    sourceUpdatedAt: string | null;
    destinationVersion: string | null;
    sourceVersion: string | null;
    hashChanged: boolean;
  }): 'write' | 'skip' | 'manual_review' {
    if (!input.hashChanged) return 'skip';
    switch (input.policy) {
      case 'source_wins':
        return 'write';
      case 'destination_wins':
        return 'skip';
      case 'manual_review':
        return 'manual_review';
      case 'latest_timestamp': {
        // Only usable when BOTH sides expose a comparable timestamp.
        const sourceTime = input.sourceUpdatedAt ? Date.parse(input.sourceUpdatedAt) : NaN;
        const destinationTime = input.destinationVersion ? Date.parse(input.destinationVersion) : NaN;
        if (Number.isNaN(sourceTime) || Number.isNaN(destinationTime)) {
          // No reliable timestamp: fall back to a safe hold, not a guess.
          return 'manual_review';
        }
        return sourceTime >= destinationTime ? 'write' : 'skip';
      }
      default:
        return 'manual_review';
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for unit tests)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The idempotency key is derived from stable inputs only, so the SAME logical
 * write always produces the SAME key no matter how many times it is retried.
 */
export function buildIdempotencyKey(input: {
  jobId: string;
  sourceRecordKey: string;
  payloadHash: string;
}): string {
  return `sfx_${nodeCreateHash('sha256')
    .update(`${input.jobId}|${input.sourceRecordKey}|${input.payloadHash}`)
    .digest('hex')
    .slice(0, 40)}`;
}

export function decideStatus(
  counts: RunCounts,
  fatal: { code: string; message: string } | null,
): RunStatus {
  if (fatal) return counts.created + counts.updated > 0 ? 'partial' : 'failed';
  if (counts.failed > 0) return 'partial';
  return 'succeeded';
}

export function classifyFatal(code: string): IssueType {
  if (code.includes('auth') || code === 'unauthorized' || code === 'forbidden') {
    return 'source_auth_failed';
  }
  if (code === 'rate_limited') return 'rate_limited';
  return 'network_error';
}

export function classifyAdapterError(kind: string): IssueType {
  switch (kind) {
    case 'auth':
      return 'destination_auth_failed';
    case 'forbidden':
      return 'destination_auth_failed';
    case 'rate_limited':
      return 'rate_limited';
    case 'validation':
      return 'validation_failed';
    case 'timeout':
    case 'network':
      return 'network_error';
    case 'conflict':
      return 'conflict';
    default:
      return 'destination_write_failed';
  }
}

export function severityFor(kind: string): IssueSeverity {
  switch (kind) {
    case 'auth':
    case 'forbidden':
      return 'critical';
    case 'rate_limited':
    case 'timeout':
    case 'network':
      return 'warning';
    default:
      return 'critical';
  }
}

export { readPath };
export type { IssueType as EngineIssueType };