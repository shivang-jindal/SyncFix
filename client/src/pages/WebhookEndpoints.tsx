import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  Paginated,
  WebhookEndpointView,
  WebhookEventView,
} from '@syncfix/shared';
import { WEBHOOK_EVENT_STATUSES } from '@syncfix/shared';

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
import { formatDateTime, formatNumber, relativeTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';

type EndpointWithSecret = WebhookEndpointView & { secret: string; warning: string };

export function WebhookEndpointsPage() {
  const api = useOrgApi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [secretView, setSecretView] = useState<EndpointWithSecret | null>(null);
  const [rotateFor, setRotateFor] = useState<WebhookEndpointView | null>(null);
  const [eventPage, setEventPage] = useState(1);
  const [eventStatus, setEventStatus] = useState('all');
  const [eventEndpoint, setEventEndpoint] = useState('all');
  const [eventDetail, setEventDetail] = useState<WebhookEventView | null>(null);

  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => api.get<{ endpoints: WebhookEndpointView[] }>('/webhook-endpoints'),
  });

  const events = useQuery({
    queryKey: ['webhook-events', eventPage, eventStatus, eventEndpoint],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(eventPage),
        pageSize: '25',
        status: eventStatus,
      });
      if (eventEndpoint !== 'all') params.set('endpointId', eventEndpoint);
      return api.get<Paginated<WebhookEventView>>(
        `/webhook-endpoints/events?${params.toString()}`,
      );
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<EndpointWithSecret>('/webhook-endpoints', {
        name: name.trim(),
        enabled,
        settings: {},
      }),
    onSuccess: (created) => {
      setCreateOpen(false);
      setName('');
      setEnabled(true);
      setFormError(null);
      setSecretView(created);
      void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    },
    onError: (error) => setFormError(messageOf(error)),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => api.post<EndpointWithSecret>(`/webhook-endpoints/${id}/rotate`),
    onSuccess: (rotated) => {
      setRotateFor(null);
      setSecretView(rotated);
      void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.patch(`/webhook-endpoints/${input.id}`, { enabled: input.enabled }),
    onSuccess: () => {
      toast.success('Endpoint updated.');
      void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied to the clipboard.`);
    } catch {
      toast.error('The clipboard is not available in this browser. Select the text and copy it.');
    }
  }

  const items = endpoints.data?.endpoints ?? [];
  const eventItems = events.data?.items ?? [];

  return (
    <Page
      title="Webhooks"
      description="Signed inbound events. Each endpoint has one URL and one signing secret; the secret is shown once and can be rotated."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New endpoint
        </Button>
      }
    >
      <div className="space-y-6">
        <Card bodyClassName="p-0">
          {endpoints.isPending ? (
            <TableSkeleton rows={3} columns={4} />
          ) : endpoints.isError ? (
            <div className="p-5">
              <ErrorState
                message={messageOf(endpoints.error)}
                onRetry={() => void endpoints.refetch()}
              />
            </div>
          ) : items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No webhook endpoints"
                description="Create an endpoint, copy its secret into the sending system, then watch deliveries appear below."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create the first endpoint
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((endpoint) => (
                <li key={endpoint.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-ink">{endpoint.name}</p>
                        <StatusBadge status={endpoint.enabled ? 'enabled' : 'disabled'} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <code className="max-w-full truncate rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-ink-muted">
                          {endpoint.url}
                        </code>
                        <Button size="sm" variant="ghost" onClick={() => void copy(endpoint.url, 'URL')}>
                          Copy URL
                        </Button>
                      </div>
                      <p className="mt-1 text-xs text-ink-subtle">
                        {formatNumber(endpoint.eventCount)} event(s) · last received{' '}
                        {relativeTime(endpoint.lastReceivedAt)} · created{' '}
                        {formatDateTime(endpoint.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setRotateFor(endpoint)}>
                        Rotate secret
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={toggle.isPending && toggle.variables?.id === endpoint.id}
                        onClick={() =>
                          toggle.mutate({ id: endpoint.id, enabled: !endpoint.enabled })
                        }
                      >
                        {endpoint.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent deliveries"
          description="Rejected and duplicate events stay visible so a misconfigured sender is never invisible."
          actions={
            <div className="flex items-end gap-2">
              <Field label="Endpoint" className="w-44">
                {({ id }) => (
                  <Select
                    id={id}
                    value={eventEndpoint}
                    onChange={(event) => {
                      setEventEndpoint(event.target.value);
                      setEventPage(1);
                    }}
                  >
                    <option value="all">All endpoints</option>
                    {items.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Status" className="w-36">
                {({ id }) => (
                  <Select
                    id={id}
                    value={eventStatus}
                    onChange={(event) => {
                      setEventStatus(event.target.value);
                      setEventPage(1);
                    }}
                  >
                    <option value="all">All</option>
                    {WEBHOOK_EVENT_STATUSES.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          }
          bodyClassName="p-0"
        >
          {events.isPending ? (
            <TableSkeleton rows={3} columns={5} />
          ) : events.isError ? (
            <div className="p-5">
              <ErrorState
                message={messageOf(events.error)}
                onRetry={() => void events.refetch()}
              />
            </div>
          ) : eventItems.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No deliveries yet"
                description="Point the sender at an endpoint URL and sign the body with its secret. Events show up here within seconds."
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Webhook deliveries</caption>
                  <thead className="border-b border-line text-left text-xs text-ink-subtle">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Endpoint</th>
                      <th scope="col" className="px-4 py-3 font-medium">External id</th>
                      <th scope="col" className="px-4 py-3 font-medium">Status</th>
                      <th scope="col" className="px-4 py-3 font-medium">Received</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventItems.map((event) => (
                      <tr key={event.id} className="border-b border-line align-top last:border-0">
                        <td className="px-4 py-3 text-ink-muted">{event.endpointName}</td>
                        <td className="px-4 py-3">
                          <p className="font-mono text-xs text-ink-muted">
                            {event.externalEventId ?? 'no external id'}
                          </p>
                          <p className="mt-0.5 max-w-xs truncate font-mono text-[11px] text-ink-subtle">
                            {event.payloadHash}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={event.status} />
                          {event.errorCode ? (
                            <p className="mt-1 font-mono text-xs text-ink-subtle">
                              {event.errorCode}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          <span title={formatDateTime(event.receivedAt)}>
                            {relativeTime(event.receivedAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEventDetail(event)}
                          >
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {events.data && events.data.totalPages > 1 ? (
                <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-ink-muted">
                  <span>
                    Page {events.data.page} of {events.data.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={eventPage <= 1}
                      onClick={() => setEventPage((value) => value - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      disabled={eventPage >= events.data.totalPages}
                      onClick={() => setEventPage((value) => value + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setFormError(null);
        }}
        title="New webhook endpoint"
        description="The signing secret is generated on the server and shown exactly once."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={name.trim().length < 2}
              onClick={() => {
                setFormError(null);
                create.mutate();
              }}
            >
              Create endpoint
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
            >
              {formError}
            </p>
          ) : null}
          <Field label="Name" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Billing provider events"
              />
            )}
          </Field>
          <Checkbox
            label="Enabled"
            hint="A disabled endpoint rejects deliveries with 403 rather than accepting and dropping them."
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </div>
      </Modal>

      <Modal
        open={secretView !== null}
        onClose={() => setSecretView(null)}
        title="Signing secret"
        description={secretView?.warning}
        footer={
          <Button variant="primary" onClick={() => setSecretView(null)}>
            I have copied it
          </Button>
        }
      >
        {secretView ? (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">Endpoint URL</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded bg-surface-sunken px-2 py-1.5 font-mono text-xs">
                  {secretView.url}
                </code>
                <Button size="sm" onClick={() => void copy(secretView.url, 'URL')}>
                  Copy
                </Button>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">Signing secret</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded bg-surface-sunken px-2 py-1.5 font-mono text-xs">
                  {secretView.secret}
                </code>
                <Button size="sm" onClick={() => void copy(secretView.secret, 'Secret')}>
                  Copy
                </Button>
              </div>
            </div>
            <p className="text-[13px] text-ink-muted">
              Sign each request body with HMAC-SHA256 using this secret and send the digest in the
              configured signature header, plus a timestamp header. Requests older than five minutes
              are rejected.
            </p>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={rotateFor !== null}
        onClose={() => setRotateFor(null)}
        title="Rotate signing secret"
        description={
          rotateFor
            ? `The current secret for “${rotateFor.name}” stops working immediately. The sender must be updated in the same window.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotateFor(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={rotate.isPending}
              onClick={() => rotateFor && rotate.mutate(rotateFor.id)}
            >
              Rotate secret
            </Button>
          </>
        }
      />

      <Modal
        open={eventDetail !== null}
        onClose={() => setEventDetail(null)}
        title="Delivery payload"
        description={
          eventDetail
            ? `${eventDetail.endpointName} · ${formatDateTime(eventDetail.receivedAt)}`
            : undefined
        }
        size="lg"
      >
        {eventDetail ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-muted">
              Stored after redaction. Fields configured as sensitive in organization settings never
              reach the database.
            </p>
            {eventDetail.redactedPayload ? (
              <pre className="max-h-80 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono text-xs text-ink">
                {JSON.stringify(eventDetail.redactedPayload, null, 2)}
              </pre>
            ) : (
              <p className="text-[13px] text-ink-subtle">
                No payload was stored for this event (it was rejected before the body was accepted).
              </p>
            )}
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}
