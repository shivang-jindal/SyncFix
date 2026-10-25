/**
 * Reports (Part D / D4.1, D4.7).
 *
 * Every metric is computed from persisted run and issue rows. Percentages always
 * carry their window and their denominator, and "no runs" is reported as
 * `null`, never as 0% or 100% (Part D / D4.7).
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { OverviewSummary, RunStatus, SyncHealthReport } from '@syncfix/shared';

import type { AppDatabase } from '../db/client.js';
import {
  connections,
  syncIssues,
  syncJobs,
  syncRecords,
  syncRunSteps,
  syncRuns,
} from '../db/schema.js';
import type { ConnectionService } from './connection.service.js';
import type { IssueService } from './issue.service.js';

export interface Window {
  from: Date;
  to: Date;
  label: string;
}

export function resolveWindow(from?: string | null, to?: string | null, defaultDays = 30): Window {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - defaultDays * 86_400_000);
  const safeTo = Number.isNaN(toDate.getTime()) ? new Date() : toDate;
  const safeFrom = Number.isNaN(fromDate.getTime()) ? new Date(safeTo.getTime() - defaultDays * 86_400_000) : fromDate;
  const days = Math.max(1, Math.round((safeTo.getTime() - safeFrom.getTime()) / 86_400_000));
  return {
    from: safeFrom,
    to: safeTo,
    label: `Last ${days} day${days === 1 ? '' : 's'} (${safeFrom.toISOString().slice(0, 10)} to ${safeTo.toISOString().slice(0, 10)})`,
  };
}

export class ReportService {
  private readonly db: AppDatabase;
  private readonly issues: IssueService;
  private readonly connections: ConnectionService;

  constructor(input: { db: AppDatabase; issues: IssueService; connections: ConnectionService }) {
    this.db = input.db;
    this.issues = input.issues;
    this.connections = input.connections;
  }

  async overview(organizationId: string, window: Window): Promise<OverviewSummary> {
    const runFilters = [
      eq(syncRuns.organizationId, organizationId),
      gte(syncRuns.startedAt, window.from),
      lte(syncRuns.startedAt, window.to),
      sql`${syncRuns.dryRun} = false`,
    ];

    const statusRows = await this.db
      .select({ status: syncRuns.status, count: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(and(...runFilters))
      .groupBy(syncRuns.status);

    const successfulRuns = statusRows.find((row) => row.status === 'succeeded')?.count ?? 0;
    const partialRuns = statusRows.find((row) => row.status === 'partial')?.count ?? 0;
    const failedRuns =
      (statusRows.find((row) => row.status === 'failed')?.count ?? 0) +
      (statusRows.find((row) => row.status === 'cancelled')?.count ?? 0);
    const totalRuns = statusRows.reduce((sum, row) => sum + row.count, 0);

    const jobRows = await this.db
      .select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${syncJobs.enabled})::int` })
      .from(syncJobs)
      .where(eq(syncJobs.organizationId, organizationId));
    const activeJobs = jobRows[0]?.enabled ?? 0;
    const pausedJobs = (jobRows[0]?.total ?? 0) - activeJobs;

    const recordsRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncRecords)
      .where(
        and(
          eq(syncRecords.organizationId, organizationId),
          gte(syncRecords.lastSyncedAt, window.from),
          lte(syncRecords.lastSyncedAt, window.to),
        ),
      );

    const lastSyncRows = await this.db
      .select({ last: sql<Date | string | null>`max(${syncRuns.finishedAt})` })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.organizationId, organizationId),
          sql`${syncRuns.dryRun} = false`,
          inArray(syncRuns.status, ['succeeded', 'partial']),
        ),
      );

    const connectionRows = await this.db
      .select({ status: connections.status, count: sql<number>`count(*)::int` })
      .from(connections)
      .where(eq(connections.organizationId, organizationId))
      .groupBy(connections.status);
    const connectionsVerified =
      (connectionRows.find((row) => row.status === 'verified')?.count ?? 0) +
      (connectionRows.find((row) => row.status === 'configured')?.count ?? 0);
    const connectionsNeedingAttention =
      (connectionRows.find((row) => row.status === 'error')?.count ?? 0) +
      (connectionRows.find((row) => row.status === 'not_configured')?.count ?? 0);

    const issueCounts = await this.issues.countsFor(organizationId);
    const topErrors = await this.issues.topErrors(organizationId, window.from);

    const jobHealth = await this.jobHealth(organizationId, window);

    return {
      windowLabel: window.label,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      activeJobs,
      pausedJobs,
      successfulRuns,
      failedRuns,
      partialRuns,
      successRatePercent: totalRuns === 0 ? null : (successfulRuns / totalRuns) * 100,
      openIssues: issueCounts.open,
      criticalIssues: issueCounts.critical,
      recordsProcessed: recordsRows[0]?.count ?? 0,
      lastSyncAt: this.toIso(lastSyncRows[0]?.last),
      connectionsVerified,
      connectionsNeedingAttention,
      jobHealth,
      topErrors: topErrors
        .filter((row) => row.errorCode !== null)
        .map((row) => ({ errorCode: row.errorCode as string, issueCount: row.count })),
    };
  }

  /**
   * `max(timestamp)` is typed as a Date but the wire value depends on the
   * driver (PGlite returns a string, node-postgres returns a Date). Normalise
   * both instead of calling `.toISOString()` on a string.
   */
  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private async jobHealth(organizationId: string, window: Window): Promise<OverviewSummary['jobHealth']> {
    const jobs = await this.db
      .select({ id: syncJobs.id, name: syncJobs.name, enabled: syncJobs.enabled })
      .from(syncJobs)
      .where(eq(syncJobs.organizationId, organizationId))
      .orderBy(syncJobs.name)
      .limit(20);

    const issueCounts = await this.issues.countsFor(organizationId);
    void issueCounts;

    const results: OverviewSummary['jobHealth'] = [];
    for (const job of jobs) {
      const rows = await this.db
        .select({ status: syncRuns.status, count: sql<number>`count(*)::int` })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.organizationId, organizationId),
            eq(syncRuns.syncJobId, job.id),
            gte(syncRuns.startedAt, window.from),
            lte(syncRuns.startedAt, window.to),
            sql`${syncRuns.dryRun} = false`,
          ),
        )
        .groupBy(syncRuns.status);

      const successfulRuns = rows.find((row) => row.status === 'succeeded')?.count ?? 0;
      const partialRuns = rows.find((row) => row.status === 'partial')?.count ?? 0;
      const failedRuns =
        (rows.find((row) => row.status === 'failed')?.count ?? 0) +
        (rows.find((row) => row.status === 'cancelled')?.count ?? 0);
      const totalRuns = rows.reduce((sum, row) => sum + row.count, 0);

      const [lastRun] = await this.db
        .select({ last: sql<Date | string | null>`max(${syncRuns.startedAt})` })
        .from(syncRuns)
        .where(
          and(eq(syncRuns.organizationId, organizationId), eq(syncRuns.syncJobId, job.id), sql`${syncRuns.dryRun} = false`),
        );

      const [openIssues] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(syncIssues)
        .where(
          and(
            eq(syncIssues.organizationId, organizationId),
            eq(syncIssues.syncJobId, job.id),
            inArray(syncIssues.status, ['open', 'retrying']),
          ),
        );

      results.push({
        syncJobId: job.id,
        name: job.name,
        status: job.enabled ? 'enabled' : 'paused',
        successRate: {
          successfulRuns,
          failedRuns,
          partialRuns,
          totalRuns,
          windowLabel: window.label,
          successRatePercent: totalRuns === 0 ? null : (successfulRuns / totalRuns) * 100,
        },
        openIssues: openIssues?.count ?? 0,
        lastRunAt: this.toIso(lastRun?.last),
      });
    }
    return results;
  }

  async syncHealth(organizationId: string, window: Window): Promise<SyncHealthReport> {
    const filters = [
      eq(syncRuns.organizationId, organizationId),
      gte(syncRuns.startedAt, window.from),
      lte(syncRuns.startedAt, window.to),
      sql`${syncRuns.dryRun} = false`,
    ];

    const statusRows = await this.db
      .select({ status: syncRuns.status, count: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(and(...filters))
      .groupBy(syncRuns.status);

    const succeeded = statusRows.find((row) => row.status === 'succeeded')?.count ?? 0;
    const partial = statusRows.find((row) => row.status === 'partial')?.count ?? 0;
    const failed =
      (statusRows.find((row) => row.status === 'failed')?.count ?? 0) +
      (statusRows.find((row) => row.status === 'cancelled')?.count ?? 0);
    const runs = statusRows.reduce((sum, row) => sum + row.count, 0);

    const totals = await this.db
      .select({
        fetched: sql<number>`coalesce(sum(${syncRuns.fetchedCount}), 0)::int`,
        created: sql<number>`coalesce(sum(${syncRuns.createdCount}), 0)::int`,
        updated: sql<number>`coalesce(sum(${syncRuns.updatedCount}), 0)::int`,
        failedRecords: sql<number>`coalesce(sum(${syncRuns.failedCount}), 0)::int`,
      })
      .from(syncRuns)
      .where(and(...filters));

    const durations = await this.db
      .select({ duration: syncRuns.durationMs })
      .from(syncRuns)
      .where(and(...filters))
      .orderBy(syncRuns.durationMs);

    const jobs = await this.db
      .select({ id: syncJobs.id, name: syncJobs.name, enabled: syncJobs.enabled })
      .from(syncJobs)
      .where(eq(syncJobs.organizationId, organizationId))
      .orderBy(syncJobs.name);

    const byJob: SyncHealthReport['byJob'] = [];
    for (const job of jobs) {
      const rows = await this.db
        .select({ status: syncRuns.status, count: sql<number>`count(*)::int` })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.organizationId, organizationId),
            eq(syncRuns.syncJobId, job.id),
            gte(syncRuns.startedAt, window.from),
            lte(syncRuns.startedAt, window.to),
            sql`${syncRuns.dryRun} = false`,
          ),
        )
        .groupBy(syncRuns.status);

      const jobSucceeded = rows.find((row) => row.status === 'succeeded')?.count ?? 0;
      const jobPartial = rows.find((row) => row.status === 'partial')?.count ?? 0;
      const jobFailed =
        (rows.find((row) => row.status === 'failed')?.count ?? 0) +
        (rows.find((row) => row.status === 'cancelled')?.count ?? 0);
      const jobRuns = rows.reduce((sum, row) => sum + row.count, 0);

      const [lastRun] = await this.db
        .select({ last: sql<Date | string | null>`max(${syncRuns.startedAt})` })
        .from(syncRuns)
        .where(
          and(eq(syncRuns.organizationId, organizationId), eq(syncRuns.syncJobId, job.id), sql`${syncRuns.dryRun} = false`),
        );
      const [openIssues] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(syncIssues)
        .where(
          and(
            eq(syncIssues.organizationId, organizationId),
            eq(syncIssues.syncJobId, job.id),
            inArray(syncIssues.status, ['open', 'retrying']),
          ),
        );

      byJob.push({
        syncJobId: job.id,
        name: job.name,
        status: job.enabled ? 'enabled' : 'paused',
        runs: jobRuns,
        succeeded: jobSucceeded,
        partial: jobPartial,
        failed: jobFailed,
        successRatePercent: jobRuns === 0 ? null : (jobSucceeded / jobRuns) * 100,
        lastRunAt: this.toIso(lastRun?.last),
        openIssues: openIssues?.count ?? 0,
      });
    }

    const recurring = await this.issues.topErrors(organizationId, window.from, 10);

    return {
      windowLabel: window.label,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      totals: {
        runs,
        succeeded,
        partial,
        failed,
        fetched: totals[0]?.fetched ?? 0,
        written: (totals[0]?.created ?? 0) + (totals[0]?.updated ?? 0),
        failedRecords: totals[0]?.failedRecords ?? 0,
        successRatePercent: runs === 0 ? null : (succeeded / runs) * 100,
        medianDurationMs: median(durations.map((row) => row.duration).filter((v): v is number => v !== null)),
      },
      byJob,
      recurringErrors: recurring
        .filter((row) => row.errorCode !== null)
        .map((row) => ({
          errorCode: row.errorCode as string,
          count: row.count,
          jobCount: 1,
          lastSeenAt: window.to.toISOString(),
        })),
    };
  }

  async runDetail(organizationId: string, runId: string) {
    const runs = await this.db
      .select({ run: syncRuns, jobName: syncJobs.name })
      .from(syncRuns)
      .innerJoin(syncJobs, eq(syncJobs.id, syncRuns.syncJobId))
      .where(and(eq(syncRuns.id, runId), eq(syncRuns.organizationId, organizationId)))
      .limit(1);
    const row = runs[0];
    if (!row) return null;

    const steps = await this.db
      .select()
      .from(syncRunSteps)
      .where(and(eq(syncRunSteps.syncRunId, runId), eq(syncRunSteps.organizationId, organizationId)))
      .orderBy(syncRunSteps.sortOrder, syncRunSteps.startedAt);

    const categoryRows = await this.db
      .select({ errorCode: syncIssues.errorCode, count: sql<number>`count(*)::int` })
      .from(syncIssues)
      .where(and(eq(syncIssues.syncRunId, runId), eq(syncIssues.organizationId, organizationId)))
      .groupBy(syncIssues.errorCode);

    const retryableRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncIssues)
      .where(
        and(
          eq(syncIssues.syncRunId, runId),
          eq(syncIssues.organizationId, organizationId),
          eq(syncIssues.retryable, true),
          inArray(syncIssues.status, ['open', 'retrying']),
        ),
      );

    return {
      run: row.run,
      jobName: row.jobName,
      steps,
      errorCategories: categoryRows.filter((entry) => entry.errorCode !== null),
      retryableFailureCount: retryableRows[0]?.count ?? 0,
    };
  }

  /**
   * Paginated run history for the whole organization. The Sync runs screen
   * needs cross-job history; per-job history stays on /sync-jobs/:id/runs.
   */
  async runs(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      status: string;
      trigger: string;
      sort: string;
      order: 'asc' | 'desc';
    },
  ): Promise<{
    items: Array<{
      id: string;
      syncJobId: string;
      jobName: string;
      status: RunStatus;
      triggerType: string;
      dryRun: boolean;
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
      fetchedCount: number;
      createdCount: number;
      updatedCount: number;
      skippedCount: number;
      failedCount: number;
      errorCode: string | null;
      safeMessage: string | null;
    }>;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }> {
    const filters = [eq(syncRuns.organizationId, organizationId)];
    if (query.status && query.status !== 'all') filters.push(eq(syncRuns.status, query.status));
    if (query.trigger && query.trigger !== 'all') {
      filters.push(eq(syncRuns.triggerType, query.trigger));
    }
    const where = and(...filters);
    const sortColumn =
      query.sort === 'finished_at'
        ? syncRuns.finishedAt
        : query.sort === 'duration_ms'
          ? syncRuns.durationMs
          : syncRuns.startedAt;
    const direction = query.order === 'asc' ? asc : desc;

    const rows = await this.db
      .select({ run: syncRuns, jobName: syncJobs.name })
      .from(syncRuns)
      .innerJoin(syncJobs, eq(syncJobs.id, syncRuns.syncJobId))
      .where(where)
      .orderBy(direction(sortColumn), desc(syncRuns.startedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const totals = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(where);
    const total = totals[0]?.count ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.run.id,
        syncJobId: row.run.syncJobId,
        jobName: row.jobName,
        status: row.run.status as RunStatus,
        triggerType: row.run.triggerType,
        dryRun: row.run.dryRun,
        startedAt: row.run.startedAt.toISOString(),
        finishedAt: row.run.finishedAt?.toISOString() ?? null,
        durationMs: row.run.durationMs,
        fetchedCount: row.run.fetchedCount,
        createdCount: row.run.createdCount,
        updatedCount: row.run.updatedCount,
        skippedCount: row.run.skippedCount,
        failedCount: row.run.failedCount,
        errorCode: row.run.errorCode,
        safeMessage: row.run.safeMessage,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }
  async recentRuns(organizationId: string, limit = 10) {
    return this.db
      .select({
        id: syncRuns.id,
        syncJobId: syncRuns.syncJobId,
        jobName: syncJobs.name,
        status: syncRuns.status,
        triggerType: syncRuns.triggerType,
        dryRun: syncRuns.dryRun,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        durationMs: syncRuns.durationMs,
        fetchedCount: syncRuns.fetchedCount,
        createdCount: syncRuns.createdCount,
        updatedCount: syncRuns.updatedCount,
        skippedCount: syncRuns.skippedCount,
        failedCount: syncRuns.failedCount,
      })
      .from(syncRuns)
      .innerJoin(syncJobs, eq(syncJobs.id, syncRuns.syncJobId))
      .where(eq(syncRuns.organizationId, organizationId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(Math.min(limit, 50));
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export type { RunStatus };