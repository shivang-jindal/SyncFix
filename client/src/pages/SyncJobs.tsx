import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  ConnectionListItem,
  Paginated,
  SyncJobListItem,
  SyncMappingView,
} from '@syncfix/shared';
import {
  CONFLICT_POLICIES,
  CONFLICT_POLICY_LABELS,
  FIELD_TYPES,
  TRANSFORM_LABELS,
  TRANSFORM_TYPES,
} from '@syncfix/shared';
import type { FieldType, TransformType } from '@syncfix/shared';

import { Modal } from '../components/Modal';
import { Page } from '../components/Page';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from '../components/ui';
import { formatDateTime, formatPercent, relativeTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';

interface MappingDraft {
  sourcePath: string;
  destinationPath: string;
  sourceType: FieldType;
  destinationType: FieldType;
  transformType: TransformType;
  transformConfig: Record<string, unknown>;
  required: boolean;
}

const EMPTY_MAPPING: MappingDraft = {
  sourcePath: '',
  destinationPath: '',
  sourceType: 'string',
  destinationType: 'string',
  transformType: 'none',
  transformConfig: {},
  required: false,
};

interface JobFormState {
  name: string;
  sourceConnectionId: string;
  destinationConnectionId: string;
  sourceEntity: string;
  destinationEntity: string;
  conflictPolicy: string;
  scheduleCron: string;
  batchSize: string;
}

const EMPTY_JOB: JobFormState = {
  name: '',
  sourceConnectionId: '',
  destinationConnectionId: '',
  sourceEntity: '',
  destinationEntity: '',
  conflictPolicy: 'source_wins',
  scheduleCron: '',
  batchSize: '50',
};

/** Transforms that need extra, explicitly-typed configuration. */
const CONFIG_FIELDS: Partial<
  Record<TransformType, Array<{ key: string; label: string; type: 'text' | 'number' }>>
> = {
  prefix: [{ key: 'value', label: 'Prefix', type: 'text' }],
  suffix: [{ key: 'value', label: 'Suffix', type: 'text' }],
  default_if_empty: [{ key: 'value', label: 'Default value', type: 'text' }],
  split_first: [{ key: 'delimiter', label: 'Separator', type: 'text' }],
  json_path: [{ key: 'path', label: 'Path inside the value', type: 'text' }],
  template: [{ key: 'template', label: 'Template, e.g. {{first}} {{last}}', type: 'text' }],
  truncate: [{ key: 'maxLength', label: 'Maximum length', type: 'number' }],
  concat: [
    { key: 'secondaryPath', label: 'Second source field', type: 'text' },
    { key: 'separator', label: 'Separator', type: 'text' },
  ],
};

export function SyncJobsPage() {
  const api = useOrgApi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<JobFormState>(EMPTY_JOB);
  const [formError, setFormError] = useState<string | null>(null);
  const [mappingJob, setMappingJob] = useState<SyncJobListItem | null>(null);
  const [mappingDraft, setMappingDraft] = useState<MappingDraft[]>([]);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SyncJobListItem | null>(null);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Paginated<ConnectionListItem>>('/connections?page=1&pageSize=100'),
  });

  const jobs = useQuery({
    queryKey: ['sync-jobs', status, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: '1', pageSize: '100', status });
      if (search.trim()) params.set('q', search.trim());
      return api.get<Paginated<SyncJobListItem>>(`/sync-jobs?${params.toString()}`);
    },
  });

  const mappings = useQuery({
    queryKey: ['sync-job-mappings', mappingJob?.id],
    enabled: mappingJob !== null,
    queryFn: () =>
      api.get<{ mappings: SyncMappingView[] }>(`/sync-jobs/${mappingJob!.id}/mappings`),
  });

  function openMappings(job: SyncJobListItem) {
    setMappingError(null);
    setMappingJob(job);
    setMappingDraft([]);
  }

  // Seed the editor when a job's mapping set arrives; local edits then win
  // because the effect only runs when the job id or the payload changes.
  useEffect(() => {
    if (!mappingJob || !mappings.data) return;
    setMappingDraft(
      mappings.data.mappings.map((mapping) => ({
        sourcePath: mapping.sourcePath,
        destinationPath: mapping.destinationPath,
        sourceType: mapping.sourceType,
        destinationType: mapping.destinationType,
        transformType: mapping.transformType,
        transformConfig: mapping.transformConfig ?? {},
        required: mapping.required,
      })),
    );
  }, [mappingJob?.id, mappings.data]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ job: SyncJobListItem }>('/sync-jobs', {
        name: form.name.trim(),
        sourceConnectionId: form.sourceConnectionId,
        destinationConnectionId: form.destinationConnectionId,
        sourceEntity: form.sourceEntity.trim(),
        destinationEntity: form.destinationEntity.trim(),
        conflictPolicy: form.conflictPolicy,
        scheduleCron: form.scheduleCron.trim() ? form.scheduleCron.trim() : null,
        batchSize: Number(form.batchSize),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setForm(EMPTY_JOB);
      setFormError(null);
      toast.success('Sync job created paused. Add mappings, then enable it.');
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error) => setFormError(messageOf(error)),
  });

  const setEnabled = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.post(`/sync-jobs/${input.id}/status`, { enabled: input.enabled }),
    onSuccess: (_data, input) => {
      toast.success(input.enabled ? 'Job enabled. Its schedule is now live.' : 'Job paused.');
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const runNow = useMutation({
    mutationFn: (input: { id: string; dryRun: boolean }) =>
      api.post<{ queued: boolean; deduplicated: boolean }>(`/sync-jobs/${input.id}/run`, {
        dryRun: input.dryRun,
      }),
    onSuccess: (result, input) => {
      toast.success(
        result.deduplicated
          ? 'A run for this job was already queued. Watch it on Sync runs.'
          : `${input.dryRun ? 'Dry run' : 'Run'} queued. Watch it on Sync runs.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/sync-jobs/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      toast.success('Sync job deleted. Its history is retained for audit.');
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const saveMappings = useMutation({
    mutationFn: (input: { id: string; mappings: MappingDraft[] }) =>
      api.post(`/sync-jobs/${input.id}/mappings`, { mappings: input.mappings }),
    onSuccess: () => {
      toast.success('Mappings saved and validated.');
      setMappingJob(null);
      setMappingDraft([]);
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error) => setMappingError(messageOf(error)),
  });

  function updateMapping(index: number, patch: Partial<MappingDraft>) {
    setMappingDraft((current) =>
      current.map((mapping, position) =>
        position === index ? { ...mapping, ...patch } : mapping,
      ),
    );
  }

  function transformConfigFor(
    transformType: TransformType,
    current: Record<string, unknown>,
  ): Record<string, unknown> {
    const fields = CONFIG_FIELDS[transformType];
    if (!fields) return {};
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const value = current[field.key];
      if (value === undefined || value === '') continue;
      next[field.key] = field.type === 'number' ? Number(value) : value;
    }
    return next;
  }

  const items = jobs.data?.items ?? [];
  const connectionItems = connections.data?.items ?? [];
  const canSaveMappings = mappingDraft.length > 0 && mappingDraft.every(
    (mapping) =>
      mapping.sourcePath.trim().length > 0 && mapping.destinationPath.trim().length > 0,
  );

  return (
    <Page
      title="Sync jobs"
      description="One-way jobs from a source entity to a destination entity. A job is created paused and runs only after you enable it."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New sync job
        </Button>
      }
    >
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="Search" className="w-56">
            {({ id }) => (
              <Input
                id={id}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Job name"
              />
            )}
          </Field>
          <Field label="Status" className="w-40">
            {({ id }) => (
              <Select id={id} value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="enabled">Enabled</option>
                <option value="paused">Paused</option>
              </Select>
            )}
          </Field>
          <p className="mb-2 text-xs text-ink-subtle">
            {jobs.data ? `${jobs.data.total} job(s)` : 'Loading…'}
          </p>
        </div>

        {jobs.isPending ? (
          <TableSkeleton rows={3} columns={6} />
        ) : jobs.isError ? (
          <div className="p-5">
            <ErrorState message={messageOf(jobs.error)} onRetry={() => void jobs.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No sync jobs yet"
              description="A job reads one entity from a source connection and upserts it into one entity on a destination connection."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create the first job
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Sync jobs in this workspace</caption>
              <thead className="border-b border-line text-left text-xs text-ink-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Job</th>
                  <th scope="col" className="px-4 py-3 font-medium">Route</th>
                  <th scope="col" className="px-4 py-3 font-medium">Schedule</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Last run</th>
                  <th scope="col" className="px-4 py-3 font-medium">Success</th>
                  <th scope="col" className="px-4 py-3 font-medium">Issues</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => {
                  const busyRun = runNow.isPending && runNow.variables?.id === job.id;
                  return (
                    <tr key={job.id} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{job.name}</p>
                        <p className="mt-0.5 text-xs text-ink-subtle">
                          {CONFLICT_POLICY_LABELS[job.conflictPolicy]} · batch {job.batchSize}
                        </p>
                        {job.schemaDrift.detected ? (
                          <p className="mt-1 text-xs text-warning">
                            Schema drift: {job.schemaDrift.unknownSourceFields.join(', ')}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        <p className="text-[13px]">
                          {job.sourceConnectionName} · {job.sourceEntity}
                        </p>
                        <p className="text-xs text-ink-subtle">
                          → {job.destinationConnectionName} · {job.destinationEntity}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {job.scheduleCron ? (
                          <>
                            <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs">
                              {job.scheduleCron}
                            </code>
                            <p className="mt-1 text-xs text-ink-subtle">{job.timezone}</p>
                          </>
                        ) : (
                          <span className="text-xs text-ink-subtle">Manual only</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {job.lastRun ? (
                          <>
                            <span title={formatDateTime(job.lastRun.startedAt)}>
                              {relativeTime(job.lastRun.startedAt)}
                            </span>
                            <p className="mt-0.5">
                              <StatusBadge status={job.lastRun.status} />
                            </p>
                          </>
                        ) : (
                          <span className="text-xs text-ink-subtle">Never ran</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {job.successRate.successRatePercent === null ? (
                          <span className="text-xs text-ink-subtle">No runs yet</span>
                        ) : (
                          <>
                            <p>{formatPercent(job.successRate.successRatePercent)}</p>
                            <p className="text-xs text-ink-subtle">
                              {job.successRate.totalRuns} run(s)
                            </p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {job.openIssueCount === 0 ? (
                          <span className="text-xs text-ink-subtle">None</span>
                        ) : (
                          <span className="text-[13px] font-medium text-danger">
                            {job.openIssueCount} open
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busyRun}
                            onClick={() => runNow.mutate({ id: job.id, dryRun: false })}
                          >
                            Run now
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => runNow.mutate({ id: job.id, dryRun: true })}
                          >
                            Dry run
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openMappings(job)}>
                            Mappings
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={
                              setEnabled.isPending && setEnabled.variables?.id === job.id
                            }
                            onClick={() =>
                              setEnabled.mutate({
                                id: job.id,
                                enabled: job.status !== 'enabled',
                              })
                            }
                          >
                            {job.status === 'enabled' ? 'Pause' : 'Enable'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(job)}>
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setFormError(null);
        }}
        title="New sync job"
        description="Jobs start paused. You will add field mappings, test a dry run, then enable the schedule."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={
                !form.name ||
                !form.sourceConnectionId ||
                !form.destinationConnectionId ||
                !form.sourceEntity ||
                !form.destinationEntity
              }
              onClick={() => {
                setFormError(null);
                create.mutate();
              }}
            >
              Create job
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            create.mutate();
          }}
        >
          {formError ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger sm:col-span-2"
            >
              {formError}
            </p>
          ) : null}
          <Field label="Name" required className="sm:col-span-2">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="CRM contacts to ERP customers"
                required
              />
            )}
          </Field>
          <Field label="Source connection" required>
            {({ id }) => (
              <Select
                id={id}
                value={form.sourceConnectionId}
                onChange={(event) =>
                  setForm({ ...form, sourceConnectionId: event.target.value })
                }
                required
              >
                <option value="">Choose a connection</option>
                {connectionItems.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Destination connection" required>
            {({ id }) => (
              <Select
                id={id}
                value={form.destinationConnectionId}
                onChange={(event) =>
                  setForm({ ...form, destinationConnectionId: event.target.value })
                }
                required
              >
                <option value="">Choose a connection</option>
                {connectionItems
                  .filter((connection) => connection.supportsWrite)
                  .map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Source entity" required hint="The collection name the adapter reads.">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.sourceEntity}
                onChange={(event) => setForm({ ...form, sourceEntity: event.target.value })}
                placeholder="contacts"
                required
              />
            )}
          </Field>
          <Field label="Destination entity" required hint="The collection the adapter writes.">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.destinationEntity}
                onChange={(event) =>
                  setForm({ ...form, destinationEntity: event.target.value })
                }
                placeholder="customers"
                required
              />
            )}
          </Field>
          <Field label="Conflict policy" required hint="Every conflict needs an explicit rule.">
            {({ id }) => (
              <Select
                id={id}
                value={form.conflictPolicy}
                onChange={(event) => setForm({ ...form, conflictPolicy: event.target.value })}
              >
                {CONFLICT_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {CONFLICT_POLICY_LABELS[policy]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Schedule" hint="Leave empty for manual runs only.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={form.scheduleCron}
                onChange={(event) => setForm({ ...form, scheduleCron: event.target.value })}
                placeholder="*/15 * * * *"
              />
            )}
          </Field>
          <Field label="Batch size" hint="1–500 records per page.">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={500}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.batchSize}
                onChange={(event) => setForm({ ...form, batchSize: event.target.value })}
              />
            )}
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>
            Create job
          </button>
        </form>
      </Modal>

      <Modal
        open={mappingJob !== null}
        onClose={() => {
          setMappingJob(null);
          setMappingDraft([]);
          setMappingError(null);
        }}
        title={mappingJob ? `Mappings · ${mappingJob.name}` : 'Mappings'}
        description="Each row copies one source field to one destination field, optionally through a named transform. No expressions or code are evaluated."
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setMappingJob(null);
                setMappingDraft([]);
                setMappingError(null);
              }}
            >
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!canSaveMappings}
              loading={saveMappings.isPending}
              onClick={() =>
                mappingJob &&
                saveMappings.mutate({ id: mappingJob.id, mappings: mappingDraft })
              }
            >
              Save mappings
            </Button>
          </>
        }
      >
        {mappingError ? (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          >
            {mappingError}
          </p>
        ) : null}

        {mappings.isPending ? (
          <TableSkeleton rows={3} columns={4} />
        ) : (
          <div className="space-y-3">
            {mappingDraft.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                No mappings yet. A job cannot be enabled until at least one source field maps to a
                destination field.
              </p>
            ) : null}
            {mappingDraft.map((mapping, index) => (
              <div key={index} className="rounded-lg border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Source field" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        value={mapping.sourcePath}
                        onChange={(event) =>
                          updateMapping(index, { sourcePath: event.target.value })
                        }
                        placeholder="first_name"
                      />
                    )}
                  </Field>
                  <Field label="Destination field" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        value={mapping.destinationPath}
                        onChange={(event) =>
                          updateMapping(index, { destinationPath: event.target.value })
                        }
                        placeholder="firstName"
                      />
                    )}
                  </Field>
                  <Field label="Source type">
                    {({ id }) => (
                      <Select
                        id={id}
                        value={mapping.sourceType}
                        onChange={(event) =>
                          updateMapping(index, { sourceType: event.target.value as FieldType })
                        }
                      >
                        {FIELD_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Destination type">
                    {({ id }) => (
                      <Select
                        id={id}
                        value={mapping.destinationType}
                        onChange={(event) =>
                          updateMapping(index, {
                            destinationType: event.target.value as FieldType,
                          })
                        }
                      >
                        {FIELD_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Transform">
                    {({ id }) => (
                      <Select
                        id={id}
                        value={mapping.transformType}
                        onChange={(event) => {
                          const transformType = event.target.value as TransformType;
                          updateMapping(index, {
                            transformType,
                            transformConfig: transformConfigFor(transformType, {}),
                          });
                        }}
                      >
                        {TRANSFORM_TYPES.map((transform) => (
                          <option key={transform} value={transform}>
                            {TRANSFORM_LABELS[transform]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <div className="flex items-end justify-between gap-3">
                    <Checkbox
                      label="Required"
                      checked={mapping.required}
                      onChange={(event) =>
                        updateMapping(index, { required: event.target.checked })
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setMappingDraft((current) =>
                          current.filter((_entry, position) => position !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  {(CONFIG_FIELDS[mapping.transformType] ?? []).map((configField) => (
                    <Field key={configField.key} label={configField.label} required>
                      {({ id }) => (
                        <Input
                          id={id}
                          type={configField.type}
                          value={String(mapping.transformConfig[configField.key] ?? '')}
                          onChange={(event) =>
                            updateMapping(index, {
                              transformConfig: {
                                ...mapping.transformConfig,
                                [configField.key]:
                                  configField.type === 'number'
                                    ? Number(event.target.value)
                                    : event.target.value,
                              },
                            })
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
              </div>
            ))}
            <Button
              onClick={() => setMappingDraft((current) => [...current, { ...EMPTY_MAPPING }])}
            >
              Add mapping
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete sync job"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” stops running immediately. Runs, records and issues already written stay available for audit.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Keep job
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
            >
              Delete job
            </Button>
          </>
        }
      />
    </Page>
  );
}
