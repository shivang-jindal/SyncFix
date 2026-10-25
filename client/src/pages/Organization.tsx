import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Paginated } from '@syncfix/shared';
import { ISSUE_SEVERITIES, ROLE_LABELS, ROLES } from '@syncfix/shared';
import type { Role } from '@syncfix/shared';

import { Modal } from '../components/Modal';
import { Page } from '../components/Page';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  TableSkeleton,
  Textarea,
} from '../components/ui';
import { formatDateTime } from '../lib/format';
import { messageOf } from '../lib/errors';
import { useOrgApi } from '../lib/orgApi';
import { useSession } from '../lib/session';

interface OrganizationPayload {
  organization: {
    id: string;
    name: string;
    slug: string;
    countryCode: string;
    timezone: string;
    baseCurrency: string;
    logoUrl: string | null;
    createdAt: string;
  };
  role: string;
  permissions: string[];
  settings: SyncSettings;
}

interface SyncSettings {
  organizationId: string;
  retentionDays: number;
  issueNotificationEmails: string[];
  notifyOnSeverity: string;
  redactFields: string[];
  updatedAt: string;
}

interface MemberRow {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
  createdAt: string;
}

interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: 'pending' | 'expired' | 'revoked';
}

interface AuditRow {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface InvitationResult {
  invitation: {
    expiresAt: string;
    acceptUrl: string;
    emailed: boolean;
    emailConfigured: boolean;
  };
}

export function OrganizationPage() {
  const api = useOrgApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { refresh } = useSession();

  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationPayload>('/'),
  });
  const runtime = useQuery({
    queryKey: ['sync-settings-runtime'],
    queryFn: () =>
      api.get<{
        settings: SyncSettings;
        runtime: { encryptionConfigured: boolean; environment: string; workerEnabled: boolean };
      }>('/settings/sync'),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: MemberRow[]; myRole: string }>('/members'),
  });
  const invitations = useQuery({
    queryKey: ['invitations'],
    enabled: org.data?.permissions.includes('member.manage') ?? false,
    queryFn: () => api.get<{ invitations: InvitationRow[] }>('/members/invitations'),
  });
  const audit = useQuery({
    queryKey: ['audit', 1],
    enabled: org.data?.permissions.includes('audit.view') ?? false,
    queryFn: () => api.get<Paginated<AuditRow>>('/audit?page=1&pageSize=25'),
  });

  const [details, setDetails] = useState({ name: '', countryCode: '', timezone: '' });
  const [settings, setSettings] = useState({
    retentionDays: '90',
    notifyOnSeverity: 'critical',
    issueNotificationEmails: '',
    redactFields: '',
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [inviteResult, setInviteResult] = useState<InvitationResult['invitation'] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removeMember, setRemoveMember] = useState<MemberRow | null>(null);
  const [transferFor, setTransferFor] = useState<MemberRow | null>(null);
  const [transferConfirm, setTransferConfirm] = useState('');

  useEffect(() => {
    if (!org.data) return;
    setDetails({
      name: org.data.organization.name,
      countryCode: org.data.organization.countryCode,
      timezone: org.data.organization.timezone,
    });
    setSettings({
      retentionDays: String(org.data.settings.retentionDays),
      notifyOnSeverity: org.data.settings.notifyOnSeverity,
      issueNotificationEmails: org.data.settings.issueNotificationEmails.join(', '),
      redactFields: org.data.settings.redactFields.join(', '),
    });
  }, [org.data]);

  const can = (permission: string) => org.data?.permissions.includes(permission) ?? false;

  const saveDetails = useMutation({
    mutationFn: () =>
      api.patch('/', {
        name: details.name.trim(),
        countryCode: details.countryCode.trim(),
        timezone: details.timezone.trim(),
      }),
    onSuccess: () => {
      toast.success('Organization details saved.');
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
      void refresh();
    },
    onError: (error) => setFormError(messageOf(error)),
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      api.patch('/settings/sync', {
        retentionDays: Number(settings.retentionDays),
        notifyOnSeverity: settings.notifyOnSeverity,
        issueNotificationEmails: settings.issueNotificationEmails
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        redactFields: settings.redactFields
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Sync settings saved. New runs use them immediately.');
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-settings-runtime'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const sendInvite = useMutation({
    mutationFn: () =>
      api.post<InvitationResult>('/members/invitations', {
        email: invite.email.trim(),
        role: invite.role,
      }),
    onSuccess: (result) => {
      setInviteResult(result.invitation);
      setInvite({ email: '', role: 'member' });
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: (error) => setFormError(messageOf(error)),
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => api.del(`/members/invitations/${id}`),
    onSuccess: () => {
      toast.success('Invitation revoked.');
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: Role }) =>
      api.patch(`/members/${input.memberId}`, { role: input.role }),
    onSuccess: () => {
      toast.success('Role updated.');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void refresh();
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (id: string) => api.del(`/members/${id}`),
    onSuccess: () => {
      setRemoveMember(null);
      toast.success('Member removed from the workspace.');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  const transfer = useMutation({
    mutationFn: (id: string) =>
      api.post('/transfer-ownership', {
        membershipId: id,
        confirmation: transferConfirm,
      }),
    onSuccess: () => {
      setTransferFor(null);
      setTransferConfirm('');
      toast.success('Ownership transferred.');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void refresh();
    },
    onError: (error) => toast.error(messageOf(error)),
  });

  return (
    <Page
      title="Organization"
      description="Workspace identity, sync policy, people and the audit trail. Changes are recorded in the audit log."
    >
      <div className="space-y-6">
        <Card title="Details" description="Used in invitation emails and report headers.">
          {org.isPending ? (
            <Skeleton className="h-32" />
          ) : org.isError ? (
            <ErrorState message={messageOf(org.error)} onRetry={() => void org.refetch()} />
          ) : (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFormError(null);
                saveDetails.mutate();
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
              <Field label="Workspace name" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={details.name}
                    onChange={(event) => setDetails({ ...details, name: event.target.value })}
                    disabled={!can('settings.manage')}
                    required
                  />
                )}
              </Field>
              <Field label="Slug" hint="Permanent identifier used in links.">
                {({ id }) => (
                  <Input id={id} value={org.data?.organization.slug ?? ''} readOnly disabled />
                )}
              </Field>
              <Field label="Country code" hint="Two-letter ISO code, e.g. US or IN.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={details.countryCode}
                    onChange={(event) =>
                      setDetails({ ...details, countryCode: event.target.value.toUpperCase() })
                    }
                    maxLength={2}
                    disabled={!can('settings.manage')}
                  />
                )}
              </Field>
              <Field label="Timezone" hint="IANA name, e.g. America/New_York.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={details.timezone}
                    onChange={(event) =>
                      setDetails({ ...details, timezone: event.target.value })
                    }
                    disabled={!can('settings.manage')}
                  />
                )}
              </Field>
              <div className="flex items-center gap-3 sm:col-span-2">
                <Button
                  variant="primary"
                  type="submit"
                  loading={saveDetails.isPending}
                  disabled={!can('settings.manage')}
                >
                  Save details
                </Button>
                <p className="text-xs text-ink-subtle">
                  Base currency {org.data?.organization.baseCurrency ?? '-'} · created{' '}
                  {formatDateTime(org.data?.organization.createdAt)}
                </p>
              </div>
            </form>
          )}
        </Card>

        <Card
          title="Sync policy"
          description="Retention, notifications and payload redaction. These are enforced by the server, not only by this form."
        >
          {runtime.isPending ? (
            <Skeleton className="h-40" />
          ) : runtime.isError ? (
            <ErrorState message={messageOf(runtime.error)} onRetry={() => void runtime.refetch()} />
          ) : (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveSettings.mutate();
              }}
            >
              <Field label="Retention (days)" required hint="Runs and resolved issues older than this are removed.">
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={365}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={settings.retentionDays}
                    onChange={(event) =>
                      setSettings({ ...settings, retentionDays: event.target.value })
                    }
                    disabled={!can('settings.manage')}
                  />
                )}
              </Field>
              <Field label="Notify on severity">
                {({ id }) => (
                  <Select
                    id={id}
                    value={settings.notifyOnSeverity}
                    onChange={(event) =>
                      setSettings({ ...settings, notifyOnSeverity: event.target.value })
                    }
                    disabled={!can('settings.manage')}
                  >
                    {ISSUE_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="Notification recipients"
                hint="Comma separated. Leave empty to keep notifications in-app only."
                className="sm:col-span-2"
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={settings.issueNotificationEmails}
                    onChange={(event) =>
                      setSettings({ ...settings, issueNotificationEmails: event.target.value })
                    }
                    placeholder="ops@example.com, oncall@example.com"
                    disabled={!can('settings.manage')}
                  />
                )}
              </Field>
              <Field
                label="Redacted payload fields"
                hint="Comma separated field names removed before an issue payload is stored."
                className="sm:col-span-2"
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={2}
                    value={settings.redactFields}
                    onChange={(event) =>
                      setSettings({ ...settings, redactFields: event.target.value })
                    }
                    disabled={!can('settings.manage')}
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button
                  variant="primary"
                  type="submit"
                  loading={saveSettings.isPending}
                  disabled={!can('settings.manage')}
                >
                  Save policy
                </Button>
                <span className="text-xs text-ink-subtle">
                  Encryption key {runtime.data?.runtime.encryptionConfigured ? 'configured' : 'missing'} ·
                  worker {runtime.data?.runtime.workerEnabled ? 'enabled' : 'disabled'} ·{' '}
                  {runtime.data?.runtime.environment}
                </span>
              </div>
            </form>
          )}
        </Card>

        <Card
          title="Members"
          description="Roles decide what people can change. A viewer can read; an owner can transfer or delete."
          actions={
            can('member.manage') ? (
              <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
                Invite person
              </Button>
            ) : null
          }
          bodyClassName="p-0"
        >
          {members.isPending ? (
            <TableSkeleton rows={3} columns={4} />
          ) : members.isError ? (
            <div className="p-4">
              <ErrorState message={messageOf(members.error)} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Workspace members</caption>
                <thead className="border-b border-line text-left text-xs text-ink-subtle">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Person</th>
                    <th scope="col" className="px-4 py-3 font-medium">Role</th>
                    <th scope="col" className="px-4 py-3 font-medium">Joined</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(members.data?.members ?? []).map((member) => {
                    const isOwner = member.role === 'owner';
                    return (
                      <tr key={member.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-medium text-ink">
                            {member.displayName || member.email}
                          </p>
                          <p className="text-xs text-ink-subtle">{member.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          {can('member.manage') && !isOwner ? (
                            <Select
                              aria-label={`Role for ${member.email}`}
                              value={member.role}
                              onChange={(event) =>
                                changeRole.mutate({
                                  memberId: member.id,
                                  role: event.target.value as Role,
                                })
                              }
                            >
                              {ROLES.filter((role) => role !== 'owner').map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABELS[role]}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <span className="text-ink-muted">{ROLE_LABELS[member.role]}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {formatDateTime(member.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isOwner ? (
                            <span className="text-xs text-ink-subtle">Owner</span>
                          ) : can('member.manage') ? (
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {can('ownership.transfer') ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setTransferConfirm('');
                                    setTransferFor(member);
                                  }}
                                >
                                  Transfer owner
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setRemoveMember(member)}
                              >
                                Remove
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {can('member.manage') ? (
          <Card title="Pending invitations" bodyClassName="p-0">
            {invitations.isPending ? (
              <TableSkeleton rows={2} columns={4} />
            ) : (invitations.data?.invitations.length ?? 0) === 0 ? (
              <p className="px-4 py-4 text-[13px] text-ink-subtle">No pending invitations.</p>
            ) : (
              <ul className="divide-y divide-line">
                {invitations.data?.invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-ink">{invitation.email}</p>
                      <p className="text-xs text-ink-subtle">
                        {ROLE_LABELS[invitation.role]} · {invitation.state} · expires{' '}
                        {formatDateTime(invitation.expiresAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={invitation.state === 'revoked'}
                      loading={
                        revokeInvite.isPending && revokeInvite.variables === invitation.id
                      }
                      onClick={() => revokeInvite.mutate(invitation.id)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {can('audit.view') ? (
          <Card
            title="Audit log"
            description="The most recent 25 events. Every mutation writes one."
            bodyClassName="p-0"
          >
            {audit.isPending ? (
              <TableSkeleton rows={5} columns={4} />
            ) : audit.isError ? (
              <div className="p-4">
                <ErrorState message={messageOf(audit.error)} />
              </div>
            ) : (audit.data?.items.length ?? 0) === 0 ? (
              <p className="px-4 py-4 text-[13px] text-ink-subtle">No audit events yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Audit events</caption>
                  <thead className="border-b border-line text-left text-xs text-ink-subtle">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Action</th>
                      <th scope="col" className="px-4 py-3 font-medium">Entity</th>
                      <th scope="col" className="px-4 py-3 font-medium">When</th>
                      <th scope="col" className="px-4 py-3 font-medium">Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data?.items.map((event) => (
                      <tr key={event.id} className="border-b border-line align-top last:border-0">
                        <td className="px-4 py-3 font-mono text-xs text-ink">{event.action}</td>
                        <td className="px-4 py-3 text-xs text-ink-muted">
                          {event.entityType}
                          <p className="max-w-[10rem] truncate font-mono text-[11px] text-ink-subtle">
                            {event.entityId ?? '-'}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {formatDateTime(event.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <p className="max-w-md truncate font-mono text-[11px] text-ink-subtle">
                            {JSON.stringify(event.metadata)}
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <Modal
        open={inviteOpen && inviteResult === null}
        onClose={() => {
          setInviteOpen(false);
          setFormError(null);
        }}
        title="Invite someone"
        description="They receive a single-use link. If email delivery is not configured, copy the link yourself."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setInviteOpen(false)}
              disabled={sendInvite.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={sendInvite.isPending}
              disabled={!invite.email.includes('@')}
              onClick={() => {
                setFormError(null);
                sendInvite.mutate();
              }}
            >
              Send invitation
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
          <Field label="Email" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                aria-describedby={describedBy}
                invalid={invalid}
                value={invite.email}
                onChange={(event) => setInvite({ ...invite, email: event.target.value })}
                placeholder="teammate@example.com"
              />
            )}
          </Field>
          <Field label="Role" required hint="Ownership is transferred separately.">
            {({ id }) => (
              <Select
                id={id}
                value={invite.role}
                onChange={(event) => setInvite({ ...invite, role: event.target.value })}
              >
                {ROLES.filter((role) => role !== 'owner').map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Modal>

      <Modal
        open={inviteResult !== null}
        onClose={() => {
          setInviteResult(null);
          setInviteOpen(false);
        }}
        title="Invitation created"
        description={
          inviteResult?.emailed
            ? 'The invitation email was sent.'
            : inviteResult?.emailConfigured
              ? 'The email is queued but has not been delivered yet. You can share the link now.'
              : 'Email delivery is not configured on this server. Share this single-use link directly.'
        }
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setInviteResult(null);
              setInviteOpen(false);
            }}
          >
            Done
          </Button>
        }
      >
        {inviteResult ? (
          <div className="space-y-3">
            <p className="text-xs font-medium text-ink-muted">Invitation link</p>
            <code className="block overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
              {inviteResult.acceptUrl}
            </code>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(inviteResult.acceptUrl)
                    .then(() => toast.success('Link copied.'))
                    .catch(() => toast.error('Copy the link manually.'));
                }}
              >
                Copy link
              </Button>
              <span className="self-center text-xs text-ink-subtle">
                Expires {formatDateTime(inviteResult.expiresAt)}
              </span>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={removeMember !== null}
        onClose={() => setRemoveMember(null)}
        title="Remove member"
        description={
          removeMember
            ? `${removeMember.email} loses access immediately. Their audit trail is retained.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveMember(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeMemberMutation.isPending}
              onClick={() => removeMember && removeMemberMutation.mutate(removeMember.id)}
            >
              Remove
            </Button>
          </>
        }
      />

      <Modal
        open={transferFor !== null}
        onClose={() => setTransferFor(null)}
        title="Transfer ownership"
        description={
          transferFor
            ? `You stop being the owner and ${transferFor.email} becomes the owner. Type TRANSFER OWNERSHIP to confirm.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransferFor(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={transferConfirm !== 'TRANSFER OWNERSHIP'}
              loading={transfer.isPending}
              onClick={() => transferFor && transfer.mutate(transferFor.id)}
            >
              Transfer
            </Button>
          </>
        }
      >
        <Field label="Typed confirmation" required>
          {({ id }) => (
            <Input
              id={id}
              value={transferConfirm}
              onChange={(event) => setTransferConfirm(event.target.value)}
              placeholder="TRANSFER OWNERSHIP"
            />
          )}
        </Field>
      </Modal>
    </Page>
  );
}
