/**
 * Issues (Part D / D2, D4.5, D5).
 *
 * An issue is an actionable, redacted record of one failure. It never contains a
 * credential, a raw authorization header or an unredacted source payload, and
 * it always carries a probable next step so a user does not need a stack trace to
 * understand what went wrong (Part D / D10).
 */

import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import {
  ISSUE_TYPE_LABELS,
  type IssueDetail,
  type IssueListItem,
  type IssueSeverity,
  type IssueStatus,
  type IssueType,
  type Paginated,
  type RepairAttemptView,
  type SyncRecordView,
} from '@syncfix/shared';

import type { AppDatabase } from '../db/client.js';
import {
  repairAttempts,
  syncIssues,
  syncJobs,
  syncRecords,
  syncRuns,
  users,
} from '../db/schema.js';
import { notFound } from '../errors.js';
import { REDACTED, redactPayloadObject } from '../lib/redact.js';
import type { AuditService } from './audit.service.js';

const _SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 3, warning: 2, info: 1 };

export interface IssueListQuery {
  page: number;
  pageSize: number;
  q?: string;
  syncJobId?: string;
  issueType?: string;
  severity?: string;
  status?: string;
  firstSeenFrom?: string;
  firstSeenTo?: string;
  sort: string;
  order: 'asc' | 'desc';
}

export interface RecordIssueInput {
  organizationId: string;
  syncJobId: string;
  syncRunId: string | null;
  recordKey: string | null;
  issueType: IssueType;
  severity: IssueSeverity;
  errorCode: string | null;
  safeMessage: string;
  redactedPayload?: Record<string, unknown> | null;
  retryable: boolean;
  /** Extra fields the organization asked to redact. */
  extraRedactKeys?: string[];
}

/** The probable next step shown on the issue detail screen. */
function probableNextStep(issueType: IssueType, errorCode: string | null, retryable: boolean): string {
  switch (issueType) {
    case 'validation_failed':
      return 'Open the field mappings for this job, map or correct the required field, then retry the record.';
    case 'transform_failed':
      return 'The allow-listed transform could not be applied to this value. Adjust the transform configuration on the mapping and retry.';
    case 'mapping_missing':
      return 'Add a mapping for this field, then retry the record.';
    case 'destination_write_failed':
      return retryable
        ? 'The destination rejected this write. Check the connection status, then retry - the write is idempotent so a retry cannot duplicate it.'
        : 'The destination rejected this write and the operation is not idempotent, so SyncFix will not retry it automatically. Fix the destination, then resolve this issue manually.';
    case 'conflict':
      return 'Review the recorded destination state and either accept the source, keep the destination, or resolve manually according to this job conflict policy.';
    case 'schema_drift':
      return 'The source started returning fields SyncFix has not seen before. Map them deliberately or acknowledge the change; nothing was dropped silently.';
    case 'source_auth_failed':
      return 'Rotate the source connection credential and test the connection, then retry.';
    case 'destination_auth_failed':
      return 'Rotate the destination connection credential and test the connection, then retry.';
    case 'rate_limited':
      return 'The provider is rate limiting this connection. Wait for the current window to clear or lower the request budget, then retry.';
    case 'network_error':
      return errorCode === 'timeout'
        ? 'The destination did not answer in time. Retry when the destination is reachable.'
        : 'The destination could not be reached. Verify the base URL and that the host resolves, then retry.';
    default:
      return 'Inspect the run step timeline for the failing step, then retry or resolve.';
  }
}

export class IssueService {
  private readonly db: AppDatabase;
  private readonly audit: AuditService;

  constructor(db: AppDatabase, audit: AuditService) {
    this.db = db;
    this.audit = audit;
  }

  /**
   * Creates or refreshes an issue. Repeating the same (job, record, type)
   * combination increments `attemptCount` and updates `lastSeenAt` instead of
   * flooding the queue with duplicates.
   */
  async record(input: RecordIssueInput): Promise<string> {
    const payload = redactPayloadObject(input.redactedPayload, {
      extraKeys: input.extraRedactKeys ?? [],
    });

    const existing = await this.db
      .select({ id: syncIssues.id, attemptCount: syncIssues.attemptCount, status: syncIssues.status })
      .from(syncIssues)
      .where(
        and(
          eq(syncIssues.organizationId, input.organizationId),
          eq(syncIssues.syncJobId, input.syncJobId),
          eq(syncIssues.issueType, input.issueType),
          input.recordKey === null
            ? sql`${syncIssues.recordKey} is null`
            : eq(syncIssues.recordKey, input.recordKey),
          inArray(syncIssues.status, ['open', 'retrying']),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await this.db
        .update(syncIssues)
        .set({
          lastSeenAt: new Date(),
          attemptCount: existing[0].attemptCount + 1,
          safeMessage: input.safeMessage.slice(0, 1_000),
          errorCode: input.errorCode,
          severity: escalate(existing[0].attemptCount, input.severity),
          retryable: input.retryable,
          ...(payload ? { redactedPayload: payload } : {}),
        })
        .where(eq(syncIssues.id, existing[0].id));
      return existing[0].id;
    }

    const inserted = await this.db
      .insert(syncIssues)
      .values({
        organizationId: input.organizationId,
        syncJobId: input.syncJobId,
        syncRunId: input.syncRunId,
        recordKey: input.recordKey,
        issueType: input.issueType,
        severity: input.severity,
        status: 'open',
        errorCode: input.errorCode,
        safeMessage: input.safeMessage.slice(0, 1_000),
        redactedPayload: payload,
        attemptCount: 1,
        retryable: input.retryable,
      })
      .returning({ id: syncIssues.id });
    return inserted[0]!.id;
  }

  async requireOwned(organizationId: string, issueId: string) {
    const rows = await this.db
      .select()
      .from(syncIssues)
      .where(and(eq(syncIssues.id, issueId), eq(syncIssues.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Issue');
    return row;
  }

  async list(organizationId: string, query: IssueListQuery): Promise<Paginated<IssueListItem>> {
    const filters: SQL[] = [eq(syncIssues.organizationId, organizationId)];
    if (query.syncJobId) filters.push(eq(syncIssues.syncJobId, query.syncJobId));
    if (query.issueType && query.issueType !== 'all') filters.push(eq(syncIssues.issueType, query.issueType));
    if (query.severity && query.severity !== 'all') filters.push(eq(syncIssues.severity, query.severity));
    if (query.status && query.status !== 'all') filters.push(eq(syncIssues.status, query.status));
    if (query.firstSeenFrom) filters.push(gte(syncIssues.firstSeenAt, new Date(query.firstSeenFrom)));
    if (query.firstSeenTo) filters.push(lte(syncIssues.firstSeenAt, new Date(query.firstSeenTo)));
    if (query.q) {
      const pattern = `%${query.q.toLowerCase()}%`;
      filters.push(
        sql`(lower(${syncIssues.safeMessage}) like ${pattern} or lower(coalesce(${syncIssues.recordKey}, '')) like ${pattern})`,
      );
    }

    const where = and(...filters);
    const sortColumn =
      query.sort === 'first_seen_at'
        ? syncIssues.firstSeenAt
        : query.sort === 'attempt_count'
          ? syncIssues.attemptCount
          : query.sort === 'severity'
            ? syncIssues.severity
            : syncIssues.lastSeenAt;
    const direction = query.order === 'asc' ? sql` asc` : sql` desc`;

    const rows = await this.db
      .select({
        issue: syncIssues,
        jobName: syncJobs.name,
      })
      .from(syncIssues)
      .innerJoin(syncJobs, eq(syncJobs.id, syncIssues.syncJobId))
      .where(where)
      .orderBy(sql`case ${sortColumn} ${query.sort === 'severity' ? sql`when 'critical' then 3 when 'warning' then 2 else 1 end` : sortColumn}${direction}`)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const totals = await this.db
      .select({ count: count() })
      .from(syncIssues)
      .where(where);

    const total = totals[0]?.count ?? 0;
    return {
      items: rows.map((row) => toListItem(row.issue, row.jobName)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async detail(organizationId: string, issueId: string): Promise<IssueDetail> {
    const rows = await this.db
      .select({ issue: syncIssues, jobName: syncJobs.name })
      .from(syncIssues)
      .innerJoin(syncJobs, eq(syncJobs.id, syncIssues.syncJobId))
      .where(and(eq(syncIssues.id, issueId), eq(syncIssues.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Issue');

    const attempts = await this.db
      .select({
        attempt: repairAttempts,
        displayName: users.displayName,
      })
      .from(repairAttempts)
      .leftJoin(users, eq(users.id, repairAttempts.initiatedBy))
      .where(eq(repairAttempts.issueId, issueId))
      .orderBy(desc(repairAttempts.startedAt));

    let record: SyncRecordView | null = null;
    if (row.issue.recordKey) {
      const recordRows = await this.db
        .select()
        .from(syncRecords)
        .where(
          and(
            eq(syncRecords.organizationId, organizationId),
            eq(syncRecords.syncJobId, row.issue.syncJobId),
            eq(syncRecords.sourceRecordKey, row.issue.recordKey),
          ),
        )
        .limit(1);
      if (recordRows[0]) record = toRecordView(recordRows[0]);
    }

    const base = toListItem(row.issue, row.jobName);
    return {
      ...base,
      redactedPayload: row.issue.redactedPayload,
      repairedPayload: row.issue.repairedPayload,
      probableNextStep: probableNextStep(
        row.issue.issueType as IssueType,
        row.issue.errorCode,
        row.issue.retryable,
      ),
      repairAttempts: attempts.map(
        (entry): RepairAttemptView => ({
          id: entry.attempt.id,
          issueId: entry.attempt.issueId,
          action: entry.attempt.action,
          status: entry.attempt.status,
          startedAt: entry.attempt.startedAt.toISOString(),
          finishedAt: entry.attempt.finishedAt?.toISOString() ?? null,
          errorCode: entry.attempt.errorCode,
          resultSummary: entry.attempt.resultSummary,
          initiatedBy: entry.displayName ?? null,
        }),
      ),
      record,
    };
  }

  async markResolved(input: {
    organizationId: string;
    issueId: string;
    actorUserId: string | null;
    reason: string;
    status?: Extract<IssueStatus, 'resolved' | 'skipped'>;
    requestId?: string | null;
  }): Promise<void> {
    const current = await this.requireOwned(input.organizationId, input.issueId);
    await this.db
      .update(syncIssues)
      .set({
        status: input.status ?? 'resolved',
        resolvedAt: new Date(),
        resolvedBy: input.actorUserId,
        resolutionReason: input.reason.slice(0, 500),
      })
      .where(eq(syncIssues.id, current.id));
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.status === 'skipped' ? 'issue.skipped' : 'issue.resolved',
      entityType: 'sync_issue',
      entityId: current.id,
      metadata: { reason: input.reason.slice(0, 200), issueType: current.issueType },
      requestId: input.requestId ?? null,
    });
  }

  async setRetrying(organizationId: string, issueId: string): Promise<void> {
    await this.db
      .update(syncIssues)
      .set({ status: 'retrying' })
      .where(and(eq(syncIssues.id, issueId), eq(syncIssues.organizationId, organizationId)));
  }

  async attachRepairPayload(
    organizationId: string,
    issueId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(syncIssues)
      .set({ repairedPayload: redactPayloadObject(payload) })
      .where(and(eq(syncIssues.id, issueId), eq(syncIssues.organizationId, organizationId)));
  }

  async openCounts(organizationId: string) {
    const rows = await this.db
      .select({ status: syncIssues.status, severity: syncIssues.severity, count: count() })
      .from(syncIssues)
      .where(eq(syncIssues.organizationId, organizationId))
      .groupBy(syncIssues.status, syncIssues.severity);
    return rows;
  }

  async topErrors(organizationId: string, since: Date, limit = 8) {
    return this.db
      .select({ errorCode: syncIssues.errorCode, count: count() })
      .from(syncIssues)
      .where(and(eq(syncIssues.organizationId, organizationId), gte(syncIssues.lastSeenAt, since)))
      .groupBy(syncIssues.errorCode)
      .orderBy(desc(count()))
      .limit(limit);
  }

  async retryableIssues(organizationId: string, limit = 50) {
    return this.db
      .select()
      .from(syncIssues)
      .where(
        and(
          eq(syncIssues.organizationId, organizationId),
          eq(syncIssues.retryable, true),
          inArray(syncIssues.status, ['open', 'retrying']),
        ),
      )
      .orderBy(desc(syncIssues.lastSeenAt))
      .limit(limit);
  }

  /** Counts used by the Overview screen. */
  async countsFor(organizationId: string) {
    const rows = await this.db
      .select({ status: syncIssues.status, severity: syncIssues.severity, count: count() })
      .from(syncIssues)
      .where(eq(syncIssues.organizationId, organizationId))
      .groupBy(syncIssues.status, syncIssues.severity);

    let open = 0;
    let critical = 0;
    for (const row of rows) {
      if (row.status === 'open' || row.status === 'retrying') {
        open += row.count;
        if (row.severity === 'critical') critical += row.count;
      }
    }
    return { open, critical };
  }

  async runsForIssue(organizationId: string, issueId: string) {
    const issue = await this.requireOwned(organizationId, issueId);
    if (!issue.syncRunId) return null;
    const rows = await this.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.id, issue.syncRunId), eq(syncRuns.organizationId, organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }
}

function escalate(attemptCount: number, severity: IssueSeverity): IssueSeverity {
  // Repeated failures become critical so they stop being easy to miss.
  if (attemptCount >= 3) return 'critical';
  return severity;
}

function toListItem(
  issue: typeof syncIssues.$inferSelect,
  jobName: string,
): IssueListItem {
  const retryable = issue.retryable && issue.status !== 'resolved' && issue.status !== 'skipped';
  return {
    id: issue.id,
    syncJobId: issue.syncJobId,
    syncJobName: jobName,
    syncRunId: issue.syncRunId,
    recordKey: issue.recordKey,
    issueType: issue.issueType as IssueType,
    severity: issue.severity as IssueSeverity,
    status: issue.status as IssueStatus,
    errorCode: issue.errorCode,
    safeMessage: issue.safeMessage || ISSUE_TYPE_LABELS[issue.issueType as IssueType] || 'Failure recorded.',
    attemptCount: issue.attemptCount,
    firstSeenAt: issue.firstSeenAt.toISOString(),
    lastSeenAt: issue.lastSeenAt.toISOString(),
    resolvedAt: issue.resolvedAt?.toISOString() ?? null,
    resolutionReason: issue.resolutionReason,
    canRetry: retryable,
    retryBlockedReason: retryable
      ? null
      : issue.status === 'resolved' || issue.status === 'skipped'
        ? `This issue is already ${issue.status}.`
        : 'The destination write is not idempotent and no safety strategy is configured, so SyncFix will not offer a retry.',
  };
}

function toRecordView(row: typeof syncRecords.$inferSelect): SyncRecordView {
  return {
    id: row.id,
    syncJobId: row.syncJobId,
    sourceRecordKey: row.sourceRecordKey,
    destinationRecordKey: row.destinationRecordKey,
    sourceVersion: row.sourceVersion,
    destinationVersion: row.destinationVersion,
    status: row.status as SyncRecordView['status'],
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastHash: row.lastHash,
    createdAt: row.createdAt.toISOString(),
  };
}

export { REDACTED };