import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Paginated, RunDetail } from '@syncfix/shared';
import { RUN_STEP_LABELS, RUN_TRIGGERS, RUN_STATUSES } from '@syncfix/shared';

import { Modal } from '../components/Modal';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Select,
  TableSkeleton,
} from '../components/ui';
import { formatDateTime, formatDuration, formatNumber, relativeTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';

interface RunListRow {
  id: string;
  syncJobId: string;
  jobName: string;
  status: string;
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
}

const PAGE_SIZE = 25;

export function SyncRunsPage() {
  const api = useOrgApi();
  const [status, setStatus] = useState('all');
  const [trigger, setTrigger] = useState('all');
  const [page, setPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['sync-runs', status, trigger, page],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        status,
        trigger,
        sort: 'started_at',
        order: 'desc',
      });
      return api.get<Paginated<RunListRow>>(`/sync-runs?${params.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const detail = useQuery({
    queryKey: ['sync-run', selectedRunId],
    enabled: selectedRunId !== null,
    queryFn: () => api.get<{ run: RunDetail }>(`/sync-runs/${selectedRunId}`),
  });

  const items = runs.data?.items ?? [];

  return (
    <Page
      title="Sync runs"
      description="Every attempt, including partial successes. Counts are the records the engine actually read and wrote."
      actions={
        <Button onClick={() => void runs.refetch()} loading={runs.isFetching}>
          Refresh
        </Button>
      }
    >
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="Status" className="w-44">
            {({ id }) => (
              <Select
                id={id}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All statuses</option>
                {RUN_STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Trigger" className="w-40">
            {({ id }) => (
              <Select
                id={id}
                value={trigger}
                onChange={(event) => {
                  setTrigger(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All triggers</option>
                {RUN_TRIGGERS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <p className="mb-2 text-xs text-ink-subtle">
            {runs.data ? `${formatNumber(runs.data.total)} run(s)` : 'Loading…'} · refreshes every
            15 seconds
          </p>
        </div>

        {runs.isPending ? (
          <TableSkeleton rows={5} columns={7} />
        ) : runs.isError ? (
          <div className="p-5">
            <ErrorState message={messageOf(runs.error)} onRetry={() => void runs.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No runs in this view"
              description="A run appears here as soon as a job is enabled and its schedule fires, or when you choose Run now on a job."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Sync runs</caption>
              <thead className="border-b border-line text-left text-xs text-ink-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Job</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Trigger</th>
                  <th scope="col" className="px-4 py-3 font-medium">Started</th>
                  <th scope="col" className="px-4 py-3 font-medium">Duration</th>
                  <th scope="col" className="px-4 py-3 font-medium">Fetched / written</th>
                  <th scope="col" className="px-4 py-3 font-medium">Failed</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <tr key={run.id} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{run.jobName}</p>
                      <p className="mt-0.5 max-w-sm truncate font-mono text-xs text-ink-subtle">
                        {run.id}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={run.status} />
                      {run.dryRun ? (
                        <p className="mt-1 text-xs text-ink-subtle">Dry run</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{run.triggerType.replace('_', ' ')}</td>
                    <td className="px-4 py-3 text-ink-muted">
                      <span title={formatDateTime(run.startedAt)}>
                        {relativeTime(run.startedAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{formatDuration(run.durationMs)}</td>
                    <td className="px-4 py-3 text-ink-muted">
                      {formatNumber(run.fetchedCount)} /{' '}
                      {formatNumber(run.createdCount + run.updatedCount)}
                      <p className="text-xs text-ink-subtle">
                        {run.dryRun ? 'projected: ' : ''}
                        {formatNumber(run.createdCount)} created,{' '}
                        {formatNumber(run.updatedCount)} updated,{' '}
                        {formatNumber(run.skippedCount)} skipped
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {run.failedCount === 0 ? (
                        <span className="text-xs text-ink-subtle">None</span>
                      ) : (
                        <span className="font-medium text-danger">
                          {formatNumber(run.failedCount)}
                        </span>
                      )}
                      {run.errorCode ? (
                        <p className="mt-0.5 text-xs text-ink-subtle">{run.errorCode}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSelectedRunId(run.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {runs.data && runs.data.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-ink-muted">
            <span>
              Page {runs.data.page} of {runs.data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                disabled={page >= runs.data.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Modal
        open={selectedRunId !== null}
        onClose={() => setSelectedRunId(null)}
        title="Run detail"
        description={
          detail.data
            ? `${detail.data.run.syncJobName} · started ${formatDateTime(detail.data.run.startedAt)}`
            : 'Loading run detail…'
        }
        size="lg"
      >
        {detail.isPending ? (
          <TableSkeleton rows={4} columns={3} />
        ) : detail.isError ? (
          <ErrorState message={messageOf(detail.error)} onRetry={() => void detail.refetch()} />
        ) : detail.data ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Fetched', detail.data.run.fetchedCount],
                ['Created', detail.data.run.createdCount],
                ['Updated', detail.data.run.updatedCount],
                ['Failed', detail.data.run.failedCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-line px-3 py-2">
                  <p className="text-xs text-ink-subtle">{label}</p>
                  <p className="text-lg font-semibold text-ink">{formatNumber(Number(value))}</p>
                </div>
              ))}
            </div>

            {detail.data.run.dryRun ? (
              <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                Dry run. Nothing was written to the destination and the checkpoint did not
                advance. Created and updated are projections; the write step reports them as
                <span className="font-medium text-ink"> would write</span>.
              </p>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Steps</h3>
              <ol className="space-y-2">
                {detail.data.run.steps.map((step) => (
                  <li
                    key={step.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-ink">
                        {RUN_STEP_LABELS[step.stepName]}
                      </p>
                      {step.safeMessage ? (
                        <p className="mt-0.5 text-xs text-ink-muted">{step.safeMessage}</p>
                      ) : null}
                      {Object.keys(step.counts).length > 0 ? (
                        <p className="mt-1 text-xs text-ink-subtle">
                          {Object.entries(step.counts)
                            .map(([key, value]) => `${key}: ${formatNumber(value)}`)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </div>
                    <div className="text-right">
                      <StatusBadge status={step.status} />
                      <p className="mt-1 text-xs text-ink-subtle">
                        {formatDuration(
                          step.finishedAt
                            ? new Date(step.finishedAt).getTime() -
                                new Date(step.startedAt).getTime()
                            : null,
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {detail.data.run.errorCategories.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink">Errors by code</h3>
                <ul className="space-y-1 text-[13px] text-ink-muted">
                  {detail.data.run.errorCategories.map((category) => (
                    <li key={category.errorCode} className="flex justify-between gap-3">
                      <span className="font-mono text-xs">{category.errorCode}</span>
                      <span>{formatNumber(category.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {detail.data.run.notes.length > 0 ? (
              <ul className="space-y-1 rounded-lg bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                {detail.data.run.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}

            <dl className="grid gap-2 border-t border-line pt-3 text-xs text-ink-subtle sm:grid-cols-2">
              <div>
                <dt className="font-medium text-ink-muted">Request id</dt>
                <dd className="font-mono">{detail.data.run.requestId ?? '-'}</dd>
              </div>
              <div>
                <dt className="font-medium text-ink-muted">Retryable failures</dt>
                <dd>{formatNumber(detail.data.run.retryableFailureCount)}</dd>
              </div>
              <div>
                <dt className="font-medium text-ink-muted">Checkpoint before</dt>
                <dd className="font-mono break-all">
                  {JSON.stringify(detail.data.run.cursorStart)}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink-muted">Checkpoint after</dt>
                <dd className="font-mono break-all">{JSON.stringify(detail.data.run.cursorEnd)}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}
