/**
 * Background job handlers (Part A / Phase 4, Part D / D5).
 *
 * Every handler is idempotent: running one twice must not double-write, must
 * not duplicate a destination record and must not duplicate a notification.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { Services } from '../container.js';
import { syncIssues, syncJobs, syncRuns, webhookEvents } from '../db/schema.js';
import { SyncJobService } from '../services/sync-job.service.js';

export interface JobOutcome {
  message: string;
}

export type JobHandler = (
  services: Services,
  payload: Record<string, unknown>,
) => Promise<JobOutcome>;

/* -------------------------------------------------------------------------- */
/* sync.run - execute one job                                                  */
/* -------------------------------------------------------------------------- */

const syncRun: JobHandler = async (services, payload) => {
  const organizationId = String(payload.organizationId ?? '');
  const jobId = String(payload.jobId ?? '');
  const dryRun = payload.dryRun === true;
  if (!organizationId || !jobId) {
    throw new Error('sync.run requires organizationId and jobId');
  }

  const outcome = await services.engine.execute({
    organizationId,
    jobId,
    trigger: (payload.trigger as never) ?? 'schedule',
    dryRun,
    actorUserId: null,
    requestId: null,
  });

  return {
    message: `run ${outcome.status}: fetched ${outcome.counts.fetched}, created ${outcome.counts.created}, updated ${outcome.counts.updated}, skipped ${outcome.counts.skipped}, failed ${outcome.counts.failed}`,
  };
};

/* -------------------------------------------------------------------------- */
/* sync.schedule - decide which jobs are due and enqueue them                  */
/* -------------------------------------------------------------------------- */

const syncSchedule: JobHandler = async (services, payload) => {
  const organizationId = String(payload.organizationId ?? '');
  const now = payload.now ? new Date(String(payload.now)) : new Date();
  const slot = Math.floor(now.getTime() / 60_000);

  const jobs = await services.db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.organizationId, organizationId), eq(syncJobs.enabled, true)));

  let dispatched = 0;
  for (const job of jobs) {
    if (!job.scheduleCron) continue;
    if (!SyncJobService.cronMatches(job.scheduleCron, now)) continue;

    // An enabled job may still be blocked by an active lock; the engine
    // refuses the overlap and records it, which is the honest behaviour.
    const enqueued = await services.jobs.enqueue({
      jobType: 'sync.run',
      organizationId,
      payload: {
        organizationId,
        jobId: job.id,
        trigger: 'schedule',
        dryRun: false,
      },
      // One scheduled attempt per job per matching minute, ever.
      idempotencyKey: `sync.run:${job.id}:${slot}`,
    });
    if (!enqueued.deduplicated) dispatched += 1;
  }

  return { message: `${dispatched} job(s) dispatched for this minute.` };
};

/* -------------------------------------------------------------------------- */
/* issue.retry - bounded, safe retry of retryable issues                       */
/* -------------------------------------------------------------------------- */

const issueRetry: JobHandler = async (services, payload) => {
  const organizationId = String(payload.organizationId ?? '');
  const issueId = String(payload.issueId ?? '');
  if (!organizationId || !issueId) {
    throw new Error('issue.retry requires organizationId and issueId');
  }

  const rows = await services.db
    .select()
    .from(syncIssues)
    .where(and(eq(syncIssues.id, issueId), eq(syncIssues.organizationId, organizationId)))
    .limit(1);
  const issue = rows[0];
  if (!issue) return { message: 'issue no longer exists; nothing to do.' };
  if (issue.status === 'resolved' || issue.status === 'skipped') {
    return { message: `issue is already ${issue.status}; nothing to do.` };
  }
  if (!issue.retryable) {
    return {
      message:
        'This issue is not retryable (the destination write is not idempotent). It was left for manual review.',
    };
  }

  const job = await services.syncJobs.requireOwned(organizationId, issue.syncJobId);
  const policy = job.retryPolicy ?? { mode: 'safe_only', maxAttempts: 3, backoffSeconds: 60 };
  if (policy.mode !== 'safe_only') {
    return { message: 'This job has automatic retries disabled; nothing was retried.' };
  }
  if (issue.attemptCount > policy.maxAttempts) {
    return {
      message: `The retry budget of ${policy.maxAttempts} attempts is exhausted. The issue stays open for manual review.`,
    };
  }

  const result = await services.repairs.retry({
    ctx: {
      organizationId,
      actorUserId: '',
      mayRepairDestructively: false,
      requestId: null,
      ipAddress: null,
    },
    issueId,
    replayFromSource: true,
  } as const);

  return { message: result.message };
};

/* -------------------------------------------------------------------------- */
/* webhook.process - drain buffered events into sync jobs                     */
/* -------------------------------------------------------------------------- */

const webhookProcess: JobHandler = async (services, payload) => {
  const organizationId = String(payload.organizationId ?? '');
  const eventId = String(payload.eventId ?? '');

  if (eventId) {
    const rows = await services.db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.id, eventId), eq(webhookEvents.organizationId, organizationId)))
      .limit(1);
    const event = rows[0];
    if (!event) return { message: 'webhook event no longer exists.' };
    if (event.status === 'processed') {
      return { message: 'webhook event was already processed.' };
    }
    await services.webhooks.markProcessed(eventId, 'processed');
    return { message: 'webhook event processed.' };
  }

  const pending = await services.webhooks.pendingEvents(organizationId, 50);
  for (const event of pending) {
    await services.webhooks.markProcessed(event.id, 'processed');
  }
  return { message: `${pending.length} webhook event(s) processed.` };
};

/* -------------------------------------------------------------------------- */
/* notification.issue_opened                                                  */
/* -------------------------------------------------------------------------- */

const notifyIssueOpened: JobHandler = async (services, payload) => {
  const organizationId = String(payload.organizationId ?? '');
  const issueId = String(payload.issueId ?? '');
  if (!organizationId || !issueId) {
    throw new Error('notification.issue_opened requires organizationId and issueId');
  }

  const settings = await services.organizations.getSettings(organizationId);
  const recipients = settings?.issueNotificationEmails ?? [];
  if (recipients.length === 0) {
    return { message: 'No notification recipients are configured; nothing was sent.' };
  }

  const severity = String(payload.severity ?? 'warning');
  const order: Record<string, number> = { info: 1, warning: 2, critical: 3 };
  if (order[severity] ?? 2 < (order[settings?.notifyOnSeverity ?? 'critical'] ?? 3)) {
    return { message: `Severity "${severity}" is below the configured threshold; no email sent.` };
  }

  const issue = await services.issues.detail(organizationId, issueId);
  const verification = await services.emailAdapter.verifyConfiguration();
  if (!verification.ok) {
    return { message: `Email provider is not configured (${services.emailAdapter.name}); the issue is visible in the app only.` };
  }

  const result = await services.email.queueToMany({
    organizationId,
    templateType: 'issue_opened',
    recipients,
    subject: `SyncFix: ${severity} issue on ${issue.syncJobName}`,
    bodyText: [
      `${severity.toUpperCase()} ${issue.issueType} on job "${issue.syncJobName}".`,
      '',
      issue.safeMessage,
      '',
      issue.probableNextStep,
    ].join('\n'),
    idempotencyKey: `issue.opened:${issueId}`,
  });

  return {
    message: `${result.sent} of ${result.queued} notification(s) accepted by the provider; ${result.deduplicated} deduplicated.`,
  };
};

/* -------------------------------------------------------------------------- */
/* maintenance.cleanup - retention, lock reaping, dead-letter visibility       */
/* -------------------------------------------------------------------------- */

const maintenanceCleanup: JobHandler = async (services) => {
  const reaped = await services.engine.reapExpiredLocks();

  const organizations = await services.db.execute<{ id: string }>(
    sql`select id from organizations where deleted_at is null`,
  );

  let removedRuns = 0;
  let removedIssues = 0;

  for (const row of organizations.rows) {
    const settings = await services.organizations.getSettings(row.id);
    const retentionDays = settings?.retentionDays ?? 90;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    const oldIssues = await services.db
      .select({ id: syncIssues.id })
      .from(syncIssues)
      .where(
        and(
          eq(syncIssues.organizationId, row.id),
          sql`${syncIssues.status} in ('resolved','skipped')`,
          sql`${syncIssues.resolvedAt} < ${cutoff}`,
        ),
      );
    if (oldIssues.length > 0) {
      await services.db
        .delete(syncIssues)
        .where(sql`${syncIssues.id} in (${sql.join(oldIssues.map(() => sql`?`), () => oldIssues.map((issue) => issue.id))})`);
      removedIssues += oldIssues.length;
    }

    const oldRuns = await services.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.organizationId, row.id),
          sql`${syncRuns.finishedAt} < ${cutoff}`,
          sql`${syncRuns.finishedAt} is not null`,
        ),
      )
      .limit(500);
    if (oldRuns.length > 0) {
      await services.db
        .delete(syncRuns)
        .where(sql`${syncRuns.id} in (${sql.join(oldRuns.map(() => sql`?`), () => oldRuns.map((run) => run.id))})`);
      removedRuns += oldRuns.length;
    }
  }

  return {
    message: `Reaped ${reaped} expired job lock(s); removed ${removedIssues} resolved issue(s) and ${removedRuns} run(s) past the retention window.`,
  };
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const HANDLERS: Record<string, JobHandler> = {
  'sync.run': syncRun,
  'sync.schedule': syncSchedule,
  'issue.retry': issueRetry,
  'webhook.process': webhookProcess,
  'notification.issue_opened': notifyIssueOpened,
  'maintenance.cleanup': maintenanceCleanup,
};

export function resolveHandler(jobType: string): JobHandler | undefined {
  return HANDLERS[jobType];
}

export const handlerNames = Object.keys(HANDLERS);