/**
 * Repair actions (Part D / D5).
 *
 * Every repair is permission-checked, audit-logged and recorded as a
 * `repair_attempts` row so a user can see exactly who did what and whether the
 * external action actually succeeded. A retry is a NEW attempt linked to the
 * original issue and run (Part D / D5.8).
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  DESTRUCTIVE_REPAIR_PHRASE,
  type IssueSeverity,
  type RepairContext,
  type RepairKind,
  type RepairResult,
} from '@syncfix/shared';

import type { AppDatabase } from '../db/client.js';
import { repairAttempts, syncIssues, syncRuns } from '../db/schema.js';
import { forbidden, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { IssueService } from './issue.service.js';
import type { RunEngine } from './run-engine.service.js';
import type { SyncJobService } from './sync-job.service.js';



export class RepairService {
  private readonly db: AppDatabase;
  private readonly audit: AuditService;
  private readonly issues: IssueService;
  private readonly jobs: SyncJobService;
  private readonly engine: RunEngine;
  private readonly logger: Logger;

  constructor(input: {
    db: AppDatabase;
    audit: AuditService;
    issues: IssueService;
    jobs: SyncJobService;
    engine: RunEngine;
    logger: Logger;
  }) {
    this.db = input.db;
    this.audit = input.audit;
    this.issues = input.issues;
    this.jobs = input.jobs;
    this.engine = input.engine;
    this.logger = input.logger;
  }

  /* ---------------------------------------------------------------------- */
  /* Retry                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Re-attempts the destination write for one failed record.
   *
   * Refused with a clear explanation when the write is not idempotent and no
   * safety strategy exists (Part D / D5: "Never offer retry if the operation is
   * non-idempotent and no safety strategy exists").
   */
  async retry(input: {
    ctx: RepairContext;
    issueId: string;
    replayFromSource: boolean;
    note?: string;
  }): Promise<RepairResult> {
    const issue = await this.issues.requireOwned(input.ctx.organizationId, input.issueId);

    if (issue.status === 'resolved' || issue.status === 'skipped') {
      return this.reject(input.ctx, 'retry', issue.id, `This issue is already ${issue.status}.`);
    }
    if (!issue.retryable) {
      return this.reject(
        input.ctx,
        'retry',
        issue.id,
        'The destination write for this record is not idempotent and no safety strategy is configured, so SyncFix will not retry it. Resolve it manually after fixing the destination.',
      );
    }
    if (!issue.recordKey) {
      return this.reject(
        input.ctx,
        'retry',
        issue.id,
        'This issue is not attached to a single record, so it cannot be retried on its own. Fix the underlying cause and run the job again.',
      );
    }

    const job = await this.jobs.requireOwned(input.ctx.organizationId, issue.syncJobId);
    const attemptId = await this.begin(input.ctx.organizationId, issue.id, input.ctx.actorUserId, 'retry');
    await this.issues.setRetrying(input.ctx.organizationId, issue.id);

    try {
      const outcome = await this.engine.execute({
        organizationId: input.ctx.organizationId,
        jobId: job.id,
        trigger: 'repair',
        dryRun: false,
        actorUserId: input.ctx.actorUserId,
        requestId: input.ctx.requestId,
        onlyRecordKey: input.replayFromSource ? null : issue.recordKey,
      });

      const summary = {
        runId: outcome.runId,
        status: outcome.status,
        written: outcome.counts.created + outcome.counts.updated,
        failed: outcome.counts.failed,
      };

      if (outcome.counts.failed === 0 && (outcome.counts.created + outcome.counts.updated) > 0) {
        await this.finish(input.ctx.organizationId, attemptId, 'succeeded', summary, null);
        await this.issues.markResolved({
          organizationId: input.ctx.organizationId,
          issueId: issue.id,
          actorUserId: input.ctx.actorUserId,
          reason: `Repaired automatically by a ${input.replayFromSource ? 'replay from source' : 'retry'}.`,
          requestId: input.ctx.requestId,
        });
        await this.audit.record({
          organizationId: input.ctx.organizationId,
          actorUserId: input.ctx.actorUserId,
          action: 'issue.retry_succeeded',
          entityType: 'sync_issue',
          entityId: issue.id,
          metadata: { runId: outcome.runId, replayFromSource: input.replayFromSource, note: input.note ?? null },
          requestId: input.ctx.requestId,
          ipAddress: input.ctx.ipAddress,
        });
        return {
          attemptId,
          status: 'succeeded',
          message: 'The record was written successfully and the issue is now resolved.',
          runId: outcome.runId,
        };
      }

      await this.finish(input.ctx.organizationId, attemptId, 'failed', summary, {
        code: outcome.errorCode ?? 'retry_failed',
        message: outcome.safeMessage ?? 'The retry did not clear the failure.',
      });
      await this.issues.setRetrying(input.ctx.organizationId, issue.id);
      await this.audit.record({
        organizationId: input.ctx.organizationId,
        actorUserId: input.ctx.actorUserId,
        action: 'issue.retry_failed',
        entityType: 'sync_issue',
        entityId: issue.id,
        metadata: { runId: outcome.runId, failed: outcome.counts.failed },
        requestId: input.ctx.requestId,
        ipAddress: input.ctx.ipAddress,
      });
      return {
        attemptId,
        status: 'failed',
        message: outcome.safeMessage ?? 'The retry did not clear the failure. The issue stays open.',
        runId: outcome.runId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The retry failed.';
      await this.finish(
        input.ctx.organizationId,
        attemptId,
        'failed',
        {},
        { code: error instanceof Error ? error.name : 'error', message },
      );
      this.logger.warn({ issueId: issue.id }, 'issue retry raised');
      return { attemptId, status: 'failed', message, runId: null };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Skip / resolve                                                          */
  /* ---------------------------------------------------------------------- */

  async skip(input: {
    ctx: RepairContext;
    issueId: string;
    reason: string;
    confirmation?: string;
  }): Promise<RepairResult> {
    const issue = await this.issues.requireOwned(input.ctx.organizationId, input.issueId);
    if (this.isDestructive(issue.issueType)) {
      this.assertDestructive(input.ctx, input.confirmation);
    }
    if (issue.status === 'resolved' || issue.status === 'skipped') {
      return this.reject(input.ctx, 'skip', issue.id, `This issue is already ${issue.status}.`);
    }

    const attemptId = await this.begin(input.ctx.organizationId, issue.id, input.ctx.actorUserId, 'skip');
    await this.issues.markResolved({
      organizationId: input.ctx.organizationId,
      issueId: issue.id,
      actorUserId: input.ctx.actorUserId,
      reason: input.reason,
      status: 'skipped',
      requestId: input.ctx.requestId,
    });
    await this.finish(input.ctx.organizationId, attemptId, 'succeeded', { reason: input.reason.slice(0, 200) }, null);
    await this.audit.record({
      organizationId: input.ctx.organizationId,
      actorUserId: input.ctx.actorUserId,
      action: 'issue.skipped',
      entityType: 'sync_issue',
      entityId: issue.id,
      metadata: { reason: input.reason.slice(0, 200), issueType: issue.issueType },
      requestId: input.ctx.requestId,
      ipAddress: input.ctx.ipAddress,
    });
    return {
      attemptId,
      status: 'succeeded',
      message: 'The issue was skipped and will not be retried. The record was not changed.',
      runId: null,
    };
  }

  async resolve(input: {
    ctx: RepairContext;
    issueId: string;
    reason: string;
    confirmation?: string;
  }): Promise<RepairResult> {
    const issue = await this.issues.requireOwned(input.ctx.organizationId, input.issueId);
    if (issue.status === 'resolved' || issue.status === 'skipped') {
      return this.reject(input.ctx, 'resolve', issue.id, `This issue is already ${issue.status}.`);
    }

    const run = issue.syncRunId
      ? await this.issues.runsForIssue(input.ctx.organizationId, issue.id)
      : null;
    const stillFailing =
      run !== null &&
      (run.failedCount > 0 || (run.status !== 'succeeded' && run.status !== 'partial'));

    if (stillFailing) {
      // Resolving while the underlying run still reports failures is a manual
      // override, so it requires the destructive permission and the typed phrase.
      this.assertDestructive(input.ctx, input.confirmation);
    }

    const attemptId = await this.begin(input.ctx.organizationId, issue.id, input.ctx.actorUserId, 'resolve');
    await this.issues.markResolved({
      organizationId: input.ctx.organizationId,
      issueId: issue.id,
      actorUserId: input.ctx.actorUserId,
      reason: input.reason,
      requestId: input.ctx.requestId,
    });
    await this.finish(input.ctx.organizationId, attemptId, 'succeeded', { reason: input.reason.slice(0, 200) }, null);
    await this.audit.record({
      organizationId: input.ctx.organizationId,
      actorUserId: input.ctx.actorUserId,
      action: 'issue.resolved',
      entityType: 'sync_issue',
      entityId: issue.id,
      metadata: {
        reason: input.reason.slice(0, 200),
        issueType: issue.issueType,
        manualOverride: stillFailing,
      },
      requestId: input.ctx.requestId,
      ipAddress: input.ctx.ipAddress,
    });
    return {
      attemptId,
      status: 'succeeded',
      message: stillFailing
        ? 'The issue was resolved manually. The underlying run still reports failures, which is recorded in the audit log.'
        : 'The issue was resolved.',
      runId: issue.syncRunId,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private isDestructive(issueType: string): boolean {
    return (
      issueType === 'destination_write_failed' ||
      issueType === 'conflict' ||
      issueType === 'schema_drift'
    );
  }

  private assertDestructive(ctx: RepairContext, confirmation?: string): void {
    if (!ctx.mayRepairDestructively) {
      throw forbidden(
        'This repair changes data at the destination. It needs the destructive repair permission, which only an owner or admin has.',
      );
    }
    if (confirmation !== DESTRUCTIVE_REPAIR_PHRASE) {
      throw unprocessable(
        `This repair changes data at the destination. Type ${DESTRUCTIVE_REPAIR_PHRASE} to confirm.`,
        { confirmation: ['Confirmation phrase does not match'] },
      );
    }
  }

  private async begin(organizationId: string, issueId: string, actorUserId: string, action: RepairKind) {
    const [row] = await this.db
      .insert(repairAttempts)
      .values({ organizationId, issueId, initiatedBy: actorUserId, action, status: 'started' })
      .returning({ id: repairAttempts.id });
    return row!.id;
  }

  private async finish(
    organizationId: string,
    attemptId: string,
    status: 'succeeded' | 'failed' | 'rejected',
    summary: Record<string, unknown>,
    error: { code: string; message: string } | null,
  ) {
    await this.db
      .update(repairAttempts)
      .set({
        status,
        finishedAt: new Date(),
        resultSummary: summary,
        errorCode: error?.code ?? null,
        safeMessage: error ? error.message.slice(0, 500) : null,
      })
      .where(and(eq(repairAttempts.id, attemptId), eq(repairAttempts.organizationId, organizationId)));
  }

  private async reject(
    ctx: RepairContext,
    action: RepairKind,
    issueId: string,
    message: string,
  ): Promise<RepairResult> {
    const attemptId = await this.begin(ctx.organizationId, issueId, ctx.actorUserId, action);
    await this.finish(ctx.organizationId, attemptId, 'rejected', {}, { code: 'rejected', message });
    await this.audit.record({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId,
      action: `issue.${action}_rejected`,
      entityType: 'sync_issue',
      entityId: issueId,
      metadata: { reason: message.slice(0, 200) },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
    return { attemptId, status: 'rejected', message, runId: null };
  }
}

/* -------------------------------------------------------------------------- */
/* Scheduled issue retry                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Re-attempts retryable issues whose backoff has elapsed. Used by the
 * `issue.retry` background job.
 */
export async function enqueueDueIssueRetries(
  db: AppDatabase,
  issues: IssueService,
  jobs: { enqueue: (input: { jobType: string; payload: Record<string, unknown>; organizationId?: string | null; idempotencyKey?: string | null; runAfter?: Date }) => Promise<unknown> },
  organizationId: string,
  backoffSeconds: number,
): Promise<number> {
  const due = await issues.retryableIssues(organizationId, 50);
  let queued = 0;
  for (const issue of due) {
    const job = await jobs.enqueue({
      jobType: 'issue.retry',
      organizationId,
      payload: { issueId: issue.id },
      idempotencyKey: `issue.retry:${issue.id}:${issue.attemptCount}`,
    });
    void job;
    queued += 1;
  }
  void db;
  void backoffSeconds;
  return queued;
}

export async function countOpenIssues(db: AppDatabase, organizationId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(syncIssues)
    .where(
      and(
        eq(syncIssues.organizationId, organizationId),
        sql`${syncIssues.status} in ('open','retrying')`,
      ),
    );
  return rows[0]?.count ?? 0;
}

export type { IssueSeverity };
export { syncRuns };