import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { IssueDetail, IssueListItem, Paginated } from '@syncfix/shared';
import {
  DESTRUCTIVE_REPAIR_PHRASE,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABELS,
} from '@syncfix/shared';

import { Modal } from '../components/Modal';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
  Textarea,
} from '../components/ui';
import { formatDateTime, formatNumber, relativeTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';

interface RepairResult {
  attemptId: string;
  status: string;
  message: string;
  runId: string | null;
}

export function IssuesPage() {
  const api = useOrgApi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('all');
  const [issueType, setIssueType] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<'retry' | 'skip' | 'resolve' | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [replayFromSource, setReplayFromSource] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const issues = useQuery({
    queryKey: ['issues', status, severity, issueType, search],
    queryFn: () => {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '100',
        status,
        severity,
        issueType,
        sort: 'last_seen_at',
        order: 'desc',
      });
      if (search.trim()) params.set('q', search.trim());
      return api.get<Paginated<IssueListItem>>(`/issues?${params.toString()}`);
    },
  });

  const detail = useQuery({
    queryKey: ['issue', selectedId],
    enabled: selectedId !== null,
    queryFn: () => api.get<{ issue: IssueDetail }>(`/issues/${selectedId}`),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['issues'] });
    void queryClient.invalidateQueries({ queryKey: ['issue', selectedId] });
    void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
  }

  const retry = useMutation({
    mutationFn: (issueId: string) =>
      api.post<RepairResult>(`/issues/${issueId}/retry`, { replayFromSource }),
    onSuccess: (result) => {
      if (result.status === 'succeeded') toast.success(result.message);
      else toast.error(result.message);
      setAction(null);
      setReason('');
      invalidate();
    },
    onError: (error) => setActionError(messageOf(error)),
  });

  const skip = useMutation({
    mutationFn: (issueId: string) =>
      api.post<RepairResult>(`/issues/${issueId}/skip`, {
        reason: reason.trim(),
        ...(confirmation.trim() ? { confirmation: confirmation.trim() } : {}),
      }),
    onSuccess: (result) => {
      if (result.status === 'succeeded') toast.success(result.message);
      else toast.error(result.message);
      setAction(null);
      setReason('');
      setConfirmation('');
      invalidate();
    },
    onError: (error) => setActionError(messageOf(error)),
  });

  const resolve = useMutation({
    mutationFn: (issueId: string) =>
      api.post<RepairResult>(`/issues/${issueId}/resolve`, {
        reason: reason.trim(),
        ...(confirmation.trim() ? { confirmation: confirmation.trim() } : {}),
      }),
    onSuccess: (result) => {
      if (result.status === 'succeeded') toast.success(result.message);
      else toast.error(result.message);
      setAction(null);
      setReason('');
      setConfirmation('');
      invalidate();
    },
    onError: (error) => setActionError(messageOf(error)),
  });

  function openAction(next: 'retry' | 'skip' | 'resolve') {
    setActionError(null);
    setReason('');
    setConfirmation('');
    setReplayFromSource(false);
    setAction(next);
  }

  const items = issues.data?.items ?? [];
  const issue = detail.data?.issue ?? null;

  return (
    <Page
      title="Issues"
      description="Every failed record stays visible until it is fixed, retried safely, skipped or resolved. Nothing is silently dropped."
      actions={
        <Button onClick={() => void issues.refetch()} loading={issues.isFetching}>
          Refresh
        </Button>
      }
    >
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="Search" className="w-52">
            {({ id }) => (
              <Input
                id={id}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Message or record key"
              />
            )}
          </Field>
          <Field label="Status" className="w-36">
            {({ id }) => (
              <Select id={id} value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All</option>
                {ISSUE_STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Severity" className="w-36">
            {({ id }) => (
              <Select
                id={id}
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
              >
                <option value="all">All</option>
                {ISSUE_SEVERITIES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Type" className="w-56">
            {({ id }) => (
              <Select
                id={id}
                value={issueType}
                onChange={(event) => setIssueType(event.target.value)}
              >
                <option value="all">All types</option>
                {ISSUE_TYPES.map((entry) => (
                  <option key={entry} value={entry}>
                    {ISSUE_TYPE_LABELS[entry]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <p className="mb-2 text-xs text-ink-subtle">
            {issues.data ? `${formatNumber(issues.data.total)} issue(s)` : 'Loading…'}
          </p>
        </div>

        {issues.isPending ? (
          <TableSkeleton rows={5} columns={6} />
        ) : issues.isError ? (
          <div className="p-5">
            <ErrorState message={messageOf(issues.error)} onRetry={() => void issues.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No issues in this view"
              description="If a run fails a record, the issue appears here with the error code, the record key and whether a safe retry is possible."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Sync issues</caption>
              <thead className="border-b border-line text-left text-xs text-ink-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Issue</th>
                  <th scope="col" className="px-4 py-3 font-medium">Job / record</th>
                  <th scope="col" className="px-4 py-3 font-medium">Severity</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                  <th scope="col" className="px-4 py-3 font-medium">Last seen</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{ISSUE_TYPE_LABELS[entry.issueType]}</p>
                      <p className="mt-0.5 max-w-md text-xs text-ink-muted">{entry.safeMessage}</p>
                      {entry.errorCode ? (
                        <p className="mt-1 font-mono text-xs text-ink-subtle">{entry.errorCode}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">
                      <p className="text-[13px]">{entry.syncJobName}</p>
                      <p className="font-mono text-xs text-ink-subtle">
                        {entry.recordKey ?? 'not record-specific'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={entry.severity} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{entry.attemptCount}</td>
                    <td className="px-4 py-3 text-ink-muted">
                      <span title={formatDateTime(entry.lastSeenAt)}>
                        {relativeTime(entry.lastSeenAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSelectedId(entry.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={selectedId !== null}
        onClose={() => {
          setSelectedId(null);
          setAction(null);
        }}
        title={issue ? ISSUE_TYPE_LABELS[issue.issueType] : 'Issue detail'}
        description={issue ? `${issue.syncJobName} · ${issue.safeMessage}` : 'Loading issue…'}
        size="lg"
        footer={
          issue ? (
            <>
              <Button variant="ghost" onClick={() => setSelectedId(null)}>
                Close
              </Button>
              <Button
                variant="secondary"
                disabled={issue.status === 'resolved' || issue.status === 'skipped'}
                onClick={() => openAction('skip')}
              >
                Skip
              </Button>
              <Button
                variant="secondary"
                disabled={issue.status === 'resolved' || issue.status === 'skipped'}
                onClick={() => openAction('resolve')}
              >
                Resolve
              </Button>
              <Button
                variant="primary"
                disabled={!issue.canRetry || issue.status === 'resolved' || issue.status === 'skipped'}
                onClick={() => openAction('retry')}
              >
                Retry safely
              </Button>
            </>
          ) : null
        }
      >
        {detail.isPending ? (
          <TableSkeleton rows={4} columns={2} />
        ) : detail.isError ? (
          <ErrorState message={messageOf(detail.error)} onRetry={() => void detail.refetch()} />
        ) : issue ? (
          <div className="space-y-4">
            <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-subtle">Status</dt>
                <dd>
                  <StatusBadge status={issue.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Severity</dt>
                <dd>
                  <StatusBadge status={issue.severity} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Record key</dt>
                <dd className="font-mono">{issue.recordKey ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Attempts</dt>
                <dd>{issue.attemptCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">First seen</dt>
                <dd>{formatDateTime(issue.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Last seen</dt>
                <dd>{formatDateTime(issue.lastSeenAt)}</dd>
              </div>
            </dl>

            <div className="rounded-lg border border-line px-3 py-2">
              <p className="text-xs font-medium text-ink-muted">Probable next step</p>
              <p className="mt-1 text-[13px] text-ink">{issue.probableNextStep}</p>
            </div>

            {!issue.canRetry && issue.retryBlockedReason ? (
              <p className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-ink">
                {issue.retryBlockedReason}
              </p>
            ) : null}

            {issue.redactedPayload ? (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">
                  Redacted source payload
                </p>
                <pre className="max-h-48 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono text-xs text-ink">
                  {JSON.stringify(issue.redactedPayload, null, 2)}
                </pre>
              </div>
            ) : null}

            {issue.repairAttempts.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">Repair attempts</p>
                <ul className="space-y-1 text-[13px]">
                  {issue.repairAttempts.map((attempt) => (
                    <li
                      key={attempt.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-2 py-1.5"
                    >
                      <span className="capitalize">
                        {attempt.action} · {formatDateTime(attempt.startedAt)}
                      </span>
                      <span className="flex items-center gap-2">
                        {attempt.errorCode ? (
                          <span className="font-mono text-xs text-ink-subtle">
                            {attempt.errorCode}
                          </span>
                        ) : null}
                        <StatusBadge status={attempt.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="border-t border-line pt-4">
              {action === null ? (
                <p className="text-[13px] text-ink-muted">
                  Choose an action to continue. Retrying re-runs only this record and records an
                  audit event.
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-[13px] font-medium text-ink">
                    {action === 'retry'
                      ? 'Retry this record'
                      : action === 'skip'
                        ? 'Skip this issue'
                        : 'Resolve this issue manually'}
                  </p>
                  {actionError ? (
                    <p
                      role="alert"
                      className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
                    >
                      {actionError}
                    </p>
                  ) : null}
                  {action === 'retry' ? (
                    <label className="flex items-start gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4"
                        checked={replayFromSource}
                        onChange={(event) => setReplayFromSource(event.target.checked)}
                      />
                      <span>
                        Re-fetch the record from the source instead of writing the stored payload.
                        The adapter must support reading a single record.
                      </span>
                    </label>
                  ) : (
                    <>
                      <Field
                        label="Reason"
                        required
                        hint="Stored on the issue and in the audit log (at least 3 characters)."
                      >
                        {({ id, describedBy }) => (
                          <Textarea
                            id={id}
                            aria-describedby={describedBy}
                            rows={3}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                        )}
                      </Field>
                      <Field
                        label="Typed confirmation"
                        hint={`Only needed when overriding a still-failing run: ${DESTRUCTIVE_REPAIR_PHRASE}`}
                      >
                        {({ id, describedBy }) => (
                          <Input
                            id={id}
                            aria-describedby={describedBy}
                            value={confirmation}
                            onChange={(event) => setConfirmation(event.target.value)}
                          />
                        )}
                      </Field>
                    </>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={() => setAction(null)}>Cancel</Button>
                    <Button
                      variant="primary"
                      loading={retry.isPending || skip.isPending || resolve.isPending}
                      disabled={action !== 'retry' && reason.trim().length < 3}
                      onClick={() => {
                        setActionError(null);
                        if (!issue) return;
                        if (action === 'retry') retry.mutate(issue.id);
                        else if (action === 'skip') skip.mutate(issue.id);
                        else resolve.mutate(issue.id);
                      }}
                    >
                      {action === 'retry' ? 'Retry now' : action === 'skip' ? 'Skip issue' : 'Resolve'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}
