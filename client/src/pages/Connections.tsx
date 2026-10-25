import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ConnectionListItem, Paginated, ProviderDescriptor } from '@syncfix/shared';

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
} from '../components/ui';
import { ApiError } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { useOrgApi } from '../lib/orgApi';

interface FormState {
  name: string;
  provider: string;
  environment: string;
  baseUrl: string;
  authScheme: string;
  username: string;
  credential: string;
}

const INITIAL: FormState = {
  name: '',
  provider: 'rest',
  environment: 'production',
  baseUrl: '',
  authScheme: 'bearer',
  username: '',
  credential: '',
};

const AUTH_SCHEMES = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api_key_header', label: 'API key header' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'none', label: 'No authentication' },
];

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

function buildConnection(form: FormState) {
  const credentials: Record<string, string> = {};
  if (form.provider === 'rest' && form.authScheme !== 'none' && form.credential) {
    if (form.authScheme === 'bearer') credentials.token = form.credential;
    else if (form.authScheme === 'api_key_header') credentials.apiKey = form.credential;
    else {
      credentials.password = form.credential;
      if (form.username) credentials.username = form.username;
    }
  }
  return {
    name: form.name.trim(),
    provider: form.provider,
    environment: form.environment,
    credentials,
    scopes: [],
    settings:
      form.provider === 'rest'
        ? { baseUrl: form.baseUrl.trim(), authScheme: form.authScheme }
        : {},
  };
}

export function ConnectionsPage() {
  const api = useOrgApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [createOpen, setCreateOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState<ConnectionListItem | null>(null);
  const [rotatingValue, setRotatingValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Paginated<ConnectionListItem>>('/connections?page=1&pageSize=100'),
  });

  const providers = useQuery({
    queryKey: ['connection-providers'],
    queryFn: () => api.get<{ providers: ProviderDescriptor[] }>('/connections/providers'),
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/connections', buildConnection(form)),
    onSuccess: () => {
      setCreateOpen(false);
      setForm(INITIAL);
      setFormError(null);
      toast.success('Connection created. Test it before enabling a job.');
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => setFormError(messageOf(error)),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.post(`/connections/${input.id}/enable`, { enabled: input.enabled }),
    onSuccess: () => {
      toast.success('Connection updated.');
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ result: { ok: boolean; safeMessage: string; latencyMs: number | null } }>(
        `/connections/${id}/test`,
      ),
    onSuccess: (result) => {
      if (result.result.ok) toast.success(result.result.safeMessage);
      else toast.error(result.result.safeMessage);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const rotate = useMutation({
    mutationFn: (input: { id: string; credentials: Record<string, string> }) =>
      api.post(`/connections/${input.id}/rotate`, { credentials: input.credentials }),
    onSuccess: () => {
      setRotateFor(null);
      setRotatingValue('');
      toast.success('Credential replaced. The old one can no longer be used.');
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  function rotateCredential(connection: ConnectionListItem) {
    const scheme = String(connection.settings.authScheme ?? 'bearer');
    const key = scheme === 'api_key_header' ? 'apiKey' : scheme === 'basic' ? 'password' : 'token';
    rotate.mutate({ id: connection.id, credentials: { [key]: rotatingValue } });
  }

  const items = list.data?.items ?? [];

  return (
    <Page
      title="Connections"
      description="Source and destination endpoints. Credentials are encrypted at rest and never shown again."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New connection
        </Button>
      }
    >
      <Card bodyClassName="p-0">
        {list.isPending ? (
          <TableSkeleton rows={4} columns={5} />
        ) : list.isError ? (
          <div className="p-5">
            <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No connections yet"
              description="Add the REST API you read from and the API you write to. Both are verified before a job can run."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Add the first connection
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Connections in this workspace</caption>
              <thead className="border-b border-line text-left text-xs text-ink-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Name</th>
                  <th scope="col" className="px-4 py-3 font-medium">Provider</th>
                  <th scope="col" className="px-4 py-3 font-medium">Environment</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Last verified</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((connection) => {
                  const provider = providers.data?.providers.find(
                    (entry) => entry.provider === connection.provider,
                  );
                  const busy = test.isPending && test.variables === connection.id;
                  return (
                    <tr key={connection.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{connection.name}</p>
                        {connection.lastErrorMessage ? (
                          <p className="mt-0.5 max-w-xs text-xs text-danger">
                            {connection.lastErrorMessage}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {provider?.displayName ?? connection.provider}
                      </td>
                      <td className="px-4 py-3 text-ink-muted capitalize">{connection.environment}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={connection.status} />
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        <span title={formatDateTime(connection.lastVerifiedAt)}>
                          {relativeTime(connection.lastVerifiedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button size="sm" loading={busy} onClick={() => test.mutate(connection.id)}>
                            Test
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRotateFor(connection);
                              setRotatingValue('');
                            }}
                          >
                            Rotate key
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={toggle.isPending && toggle.variables?.id === connection.id}
                            onClick={() =>
                              toggle.mutate({
                                id: connection.id,
                                enabled: connection.status === 'disabled',
                              })
                            }
                          >
                            {connection.status === 'disabled' ? 'Enable' : 'Disable'}
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
        title="New connection"
        description="SyncFix verifies the endpoint and credential before a job can use it."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() => {
                setFormError(null);
                create.mutate();
              }}
            >
              Create connection
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
            <p role="alert" className="sm:col-span-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {formError}
            </p>
          ) : null}
          <Field label="Name" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Production CRM"
                required
              />
            )}
          </Field>
          <Field label="Provider" required hint="Only implemented adapters are listed.">
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.provider}
                onChange={(event) => setForm({ ...form, provider: event.target.value })}
              >
                {(providers.data?.providers ?? []).map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {provider.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Environment" required>
            {({ id }) => (
              <Select
                id={id}
                value={form.environment}
                onChange={(event) => setForm({ ...form, environment: event.target.value })}
              >
                <option value="production">Production</option>
                <option value="sandbox">Sandbox</option>
                <option value="development">Development</option>
              </Select>
            )}
          </Field>
          {form.provider === 'rest' ? (
            <>
              <Field
                label="Base URL"
                required
                hint="Must be an http(s) URL you control. Private network addresses are rejected."
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={form.baseUrl}
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    required
                  />
                )}
              </Field>
              <Field label="Authentication" required>
                {({ id }) => (
                  <Select
                    id={id}
                    value={form.authScheme}
                    onChange={(event) => setForm({ ...form, authScheme: event.target.value })}
                  >
                    {AUTH_SCHEMES.map((scheme) => (
                      <option key={scheme.value} value={scheme.value}>
                        {scheme.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {form.authScheme === 'basic' ? (
                <Field label="Username" required>
                  {({ id, invalid }) => (
                    <Input
                      id={id}
                      invalid={invalid}
                      value={form.username}
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                      autoComplete="off"
                    />
                  )}
                </Field>
              ) : null}
              {form.authScheme !== 'none' ? (
                <Field
                  label={form.authScheme === 'basic' ? 'Password' : 'Credential'}
                  required
                  hint="Encrypted at rest. It cannot be read back after saving."
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="password"
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={form.credential}
                      onChange={(event) => setForm({ ...form, credential: event.target.value })}
                      autoComplete="new-password"
                    />
                  )}
                </Field>
              ) : null}
            </>
          ) : (
            <p className="sm:col-span-2 text-[13px] text-ink-muted">
              A webhook-ingest connection receives signed events. Its endpoint and secret are
              managed on the Webhooks page.
            </p>
          )}
          <button type="submit" className="sr-only" tabIndex={-1}>
            Create connection
          </button>
        </form>
      </Modal>

      <Modal
        open={rotateFor !== null}
        onClose={() => setRotateFor(null)}
        title="Replace credential"
        description={
          rotateFor
            ? `The old credential for “${rotateFor.name}” stops working as soon as you save.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotateFor(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={rotate.isPending}
              disabled={rotatingValue.length === 0}
              onClick={() => rotateFor && rotateCredential(rotateFor)}
            >
              Replace credential
            </Button>
          </>
        }
      >
        <Field label="New credential" required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              type="password"
              aria-describedby={describedBy}
              value={rotatingValue}
              onChange={(event) => setRotatingValue(event.target.value)}
              autoComplete="new-password"
            />
          )}
        </Field>
      </Modal>
    </Page>
  );
}
