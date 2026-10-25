import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { OverviewSummary, SyncHealthReport } from '@syncfix/shared';

import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
} from '../components/ui';
import { formatDateTime, formatDuration, formatNumber, formatPercent, relativeTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';

interface QueueSnapshot {
  stats: Record<string, number>;
  deadLetter: Array<{
    id: string;
    jobType: string;
    attempts: number;
    maxAttempts: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    runAfter: string;
    completedAt: string | null;
  }>;
}

const WINDOWS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

function windowParams(days: number): string {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'danger' | 'success';
}) {
  return (
    <div className="rounded-lg border border-line bg-white px-4 py-3">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p
        className={
          tone === 'danger'
            ? 'mt-1 text-2xl font-semibold text-danger'
            : tone === 'success'
              ? 'mt-1 text-2xl font-semibold text-[color:var(--color-success)]'
              : 'mt-1 text-2xl font-semibold text-ink'
        }
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

export function ReportsPage() {
  const api = useOrgApi();
  const [days, setDays] = useState(30);
  const params = windowParams(days);

  const overview = useQuery({
    queryKey: ['overview', days],
    queryFn: () => api.get<OverviewSummary>(`/reports/overview?${params}`),
  });
  const health = useQuery({
    queryKey: ['sync-health', days],
    queryFn: () => api.get<SyncHealthReport>(`/reports/sync-health?${params}`),
  });
  const queue = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<QueueSnapshot>('/reports/queue'),
    refetchInterval: 30_000,
  });

  const data = overview.data;

  return (
    <Page
      title="Reports"
      description="Metrics are computed from persisted runs and issues. A percentage is only shown when there is something to divide by."
      actions={
        <Field label="Window" className="w-44">
          {({ id }) => (
            <Select
              id={id}
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {WINDOWS.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      }
    >
      {overview.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : overview.isError ? (
        <ErrorState
          message={messageOf(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      ) : data ? (
        <div className="space-y-6">
          <p className="text-xs text-ink-subtle">{data.windowLabel}</p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Success rate"
              value={
                data.successRatePercent === null ? 'No runs' : formatPercent(data.successRatePercent)
              }
              hint={`${formatNumber(data.successfulRuns)} succeeded · ${formatNumber(data.partialRuns)} partial · ${formatNumber(data.failedRuns)} failed`}
              tone={
                data.successRatePercent === null
                  ? 'default'
                  : data.successRatePercent >= 95
                    ? 'success'
                    : 'danger'
              }
            />
            <Stat
              label="Active jobs"
              value={formatNumber(data.activeJobs)}
              hint={`${formatNumber(data.pausedJobs)} paused`}
            />
            <Stat
              label="Open issues"
              value={formatNumber(data.openIssues)}
              hint={`${formatNumber(data.criticalIssues)} critical`}
              tone={data.criticalIssues > 0 ? 'danger' : 'default'}
            />
            <Stat
              label="Records processed"
              value={formatNumber(data.recordsProcessed)}
              hint={`Last sync ${relativeTime(data.lastSyncAt)}`}
            />
            <Stat
              label="Connections verified"
              value={formatNumber(data.connectionsVerified)}
              hint={`${formatNumber(data.connectionsNeedingAttention)} need attention`}
              tone={data.connectionsNeedingAttention > 0 ? 'danger' : 'success'}
            />
            <Stat
              label="Runs in window"
              value={formatNumber(data.successfulRuns + data.partialRuns + data.failedRuns)}
              hint="Successful + partial + failed"
            />
            <Stat
              label="Median run time"
              value={formatDuration(health.data?.totals.medianDurationMs ?? null)}
              hint="Across finished runs in the window"
            />
            <Stat
              label="Failed records"
              value={formatNumber(health.data?.totals.failedRecords ?? 0)}
              hint={`${formatNumber(health.data?.totals.written ?? 0)} written`}
              tone={(health.data?.totals.failedRecords ?? 0) > 0 ? 'danger' : 'default'}
            />
          </div>

          <Card title="Job health" bodyClassName="p-0">
            {data.jobHealth.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No jobs yet"
                  description="Create a sync job and enable it; its health appears here after the first run."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Health per sync job</caption>
                  <thead className="border-b border-line text-left text-xs text-ink-subtle">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Job</th>
                      <th scope="col" className="px-4 py-3 font-medium">Status</th>
                      <th scope="col" className="px-4 py-3 font-medium">Success</th>
                      <th scope="col" className="px-4 py-3 font-medium">Open issues</th>
                      <th scope="col" className="px-4 py-3 font-medium">Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobHealth.map((job) => (
                      <tr key={job.syncJobId} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 font-medium text-ink">{job.name}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={job.status} />
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {job.successRate.successRatePercent === null
                            ? 'No runs'
                            : formatPercent(job.successRate.successRatePercent)}
                          <span className="ml-2 text-xs text-ink-subtle">
                            {job.successRate.totalRuns} run(s)
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {job.openIssues === 0 ? 'None' : `${job.openIssues} open`}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          <span title={formatDateTime(job.lastRunAt)}>
                            {relativeTime(job.lastRunAt)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Top error codes" description="Open issues in this window.">
              {data.topErrors.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No open issues in this window.</p>
              ) : (
                <ul className="space-y-2">
                  {data.topErrors.map((error) => (
                    <li key={error.errorCode} className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs text-ink-muted">{error.errorCode}</span>
                      <span className="text-sm font-medium text-ink">
                        {formatNumber(error.issueCount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Recurring errors" description="Seen across more than one job.">
              {health.isPending ? (
                <Skeleton className="h-16" />
              ) : health.isError ? (
                <ErrorState message={messageOf(health.error)} />
              ) : health.data && health.data.recurringErrors.length > 0 ? (
                <ul className="space-y-2">
                  {health.data.recurringErrors.map((error) => (
                    <li
                      key={error.errorCode}
                      className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
                    >
                      <span className="font-mono text-xs text-ink-muted">{error.errorCode}</span>
                      <span className="text-ink-subtle">
                        {formatNumber(error.count)} occurrence(s) · {error.jobCount} job(s) ·{' '}
                        {relativeTime(error.lastSeenAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-muted">
                  No error repeats across jobs in this window.
                </p>
              )}
            </Card>
          </div>

          <Card title="Per-job run totals" bodyClassName="p-0">
            {health.isPending ? (
              <Skeleton className="m-4 h-20" />
            ) : health.data && health.data.byJob.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Run totals per job</caption>
                  <thead className="border-b border-line text-left text-xs text-ink-subtle">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Job</th>
                      <th scope="col" className="px-4 py-3 font-medium">Runs</th>
                      <th scope="col" className="px-4 py-3 font-medium">Succeeded</th>
                      <th scope="col" className="px-4 py-3 font-medium">Partial</th>
                      <th scope="col" className="px-4 py-3 font-medium">Failed</th>
                      <th scope="col" className="px-4 py-3 font-medium">Success rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.data.byJob.map((job) => (
                      <tr key={job.syncJobId} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 font-medium text-ink">{job.name}</td>
                        <td className="px-4 py-3 text-ink-muted">{formatNumber(job.runs)}</td>
                        <td className="px-4 py-3 text-ink-muted">
                          {formatNumber(job.succeeded)}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">{formatNumber(job.partial)}</td>
                        <td className="px-4 py-3 text-ink-muted">{formatNumber(job.failed)}</td>
                        <td className="px-4 py-3 text-ink-muted">
                          {job.successRatePercent === null
                            ? 'No runs'
                            : formatPercent(job.successRatePercent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-5">
                <EmptyState
                  title="Nothing ran in this window"
                  description="Choose a wider window, or enable a job and run it."
                />
              </div>
            )}
          </Card>

          <Card
            title="Background queue"
            description="Exhausted jobs stay visible in the dead-letter list so they can be retried deliberately."
            actions={
              <Button size="sm" onClick={() => void queue.refetch()} loading={queue.isFetching}>
                Refresh
              </Button>
            }
            bodyClassName="p-0"
          >
            {queue.isPending ? (
              <Skeleton className="m-4 h-16" />
            ) : queue.isError ? (
              <div className="p-4">
                <ErrorState message={messageOf(queue.error)} />
              </div>
            ) : queue.data ? (
              <div>
                <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
                  {Object.keys(queue.data.stats).length === 0 ? (
                    <span className="text-[13px] text-ink-subtle">No background jobs yet.</span>
                  ) : (
                    Object.entries(queue.data.stats).map(([status, count]) => (
                      <span
                        key={status}
                        className="rounded-full bg-surface-sunken px-2.5 py-1 text-xs text-ink-muted"
                      >
                        {status}: {formatNumber(count)}
                      </span>
                    ))
                  )}
                </div>
                {queue.data.deadLetter.length === 0 ? (
                  <p className="px-4 py-4 text-[13px] text-ink-subtle">Dead letter is empty.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Dead-letter background jobs</caption>
                      <thead className="border-b border-line text-left text-xs text-ink-subtle">
                        <tr>
                          <th scope="col" className="px-4 py-3 font-medium">Job type</th>
                          <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                          <th scope="col" className="px-4 py-3 font-medium">Last error</th>
                          <th scope="col" className="px-4 py-3 font-medium">Completed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {queue.data.deadLetter.map((job) => (
                          <tr key={job.id} className="border-b border-line last:border-0">
                            <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                              {job.jobType}
                            </td>
                            <td className="px-4 py-3 text-ink-muted">
                              {job.attempts}/{job.maxAttempts}
                            </td>
                            <td className="px-4 py-3 text-ink-muted">
                              {job.lastErrorCode ?? '-'}
                              {job.lastErrorMessage ? (
                                <p className="max-w-sm truncate text-xs text-ink-subtle">
                                  {job.lastErrorMessage}
                                </p>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-ink-muted">
                              {formatDateTime(job.completedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}
    </Page>
  );
}
