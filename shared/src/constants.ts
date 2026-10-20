/** Domain constants shared by the SyncFix server and client. */

export const PRODUCT_NAME = 'SyncFix';

/* -------------------------------------------------------------------------- */
/* Tenancy and roles (Part A / A5, Part D / D3)                               */
/* -------------------------------------------------------------------------- */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Engineer / operator',
  viewer: 'Viewer',
};

/**
 * SyncFix permissions (Part D / D3).
 *
 * `member` maps to the "engineer / operator" role: they can inspect runs and
 * issues and retry safe operations. Destructive repairs need the separate
 * `issue.repair.destructive` flag which is only held by owner/admin, and a
 * typed confirmation in the UI.
 */
export const PERMISSIONS = [
  'connection.manage',
  'connection.rotate',
  'job.view',
  'job.manage',
  'job.run',
  'job.pause',
  'mapping.view',
  'mapping.manage',
  'issue.view',
  'issue.repair',
  'issue.repair.destructive',
  'webhook.manage',
  'report.view',
  'settings.manage',
  'member.manage',
  'audit.view',
  'ownership.transfer',
  'organization.delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: Permission[] = [
  'job.view',
  'mapping.view',
  'issue.view',
  'report.view',
  'audit.view',
];
const MEMBER_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  'job.run',
  'job.pause',
  'mapping.manage',
  'issue.repair',
];
const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'connection.manage',
  'connection.rotate',
  'job.manage',
  'issue.repair.destructive',
  'webhook.manage',
  'settings.manage',
  'member.manage',
];

export function permissionsForRole(role: Role): Permission[] {
  switch (role) {
    case 'owner':
      return [...PERMISSIONS];
    case 'admin':
      return [...ADMIN_PERMISSIONS];
    case 'member':
      return [...MEMBER_PERMISSIONS];
    case 'viewer':
      return [...VIEWER_PERMISSIONS];
  }
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/* -------------------------------------------------------------------------- */
/* Connections and adapters (Part D / D2, D8)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Providers that SyncFix actually implements and tests.
 *
 * Nothing else is listed. Any other system is reached through one of these two
 * generic adapters with an explicitly configured, documented endpoint.
 */
export const PROVIDER_KINDS = ['rest', 'webhook_ingest'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const CONNECTION_STATUSES = [
  'not_configured',
  'configured',
  'verified',
  'error',
  'disabled',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_ENVIRONMENTS = ['production', 'sandbox', 'development'] as const;
export type ConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

/** Authentication schemes the generic REST connector accepts (Part D / D8). */
export const REST_AUTH_SCHEMES = ['none', 'bearer', 'api_key_header', 'basic'] as const;
export type RestAuthScheme = (typeof REST_AUTH_SCHEMES)[number];

/** HTTP methods the REST connector will issue. Reads use GET; writes use PUT (idempotent upsert). */
export const REST_SAFE_METHODS = ['GET'] as const;
export const REST_WRITE_METHODS = ['PUT'] as const;

/* -------------------------------------------------------------------------- */
/* Sync jobs (Part D / D4)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * v1 supports one-way source -> destination only. Bidirectional sync is
 * deliberately NOT offered because conflict loops and versioning are not fully
 * handled (Part D / D9).
 */
export const SYNC_MODES = ['one_way'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const JOB_STATUSES = ['paused', 'enabled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Every conflict needs an explicit, stored policy (Part D / D9). */
export const CONFLICT_POLICIES = [
  'source_wins',
  'destination_wins',
  'latest_timestamp',
  'manual_review',
] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const CONFLICT_POLICY_LABELS: Record<ConflictPolicy, string> = {
  source_wins: 'Source wins',
  destination_wins: 'Destination wins',
  latest_timestamp: 'Newest reliable timestamp wins',
  manual_review: 'Hold for manual review',
};

export const RETRY_MODES = ['never', 'safe_only'] as const;
export type RetryMode = (typeof RETRY_MODES)[number];

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export const RUN_TRIGGERS = ['manual', 'schedule', 'webhook', 'repair', 'dry_run'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * `partial` is a first-class terminal state: a run that wrote some records and
 * failed others must never be reported as a success (Part D / D9).
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial success',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Structured run-step timeline (Part D / D4.4). */
export const RUN_STEP_NAMES = [
  'acquire_lock',
  'fetch',
  'validate',
  'transform',
  'write',
  'checkpoint',
] as const;
export type RunStepName = (typeof RUN_STEP_NAMES)[number];

export const RUN_STEP_LABELS: Record<RunStepName, string> = {
  acquire_lock: 'Acquire job lock',
  fetch: 'Fetch records',
  validate: 'Validate',
  transform: 'Transform',
  write: 'Write to destination',
  checkpoint: 'Commit checkpoint',
};

export const SYNC_RECORD_STATUSES = [
  'synced',
  'created',
  'updated',
  'skipped',
  'failed',
  'conflict',
] as const;
export type SyncRecordStatus = (typeof SYNC_RECORD_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Issues and repair (Part D / D5)                                            */
/* -------------------------------------------------------------------------- */

export const ISSUE_TYPES = [
  'validation_failed',
  'transform_failed',
  'destination_write_failed',
  'conflict',
  'schema_drift',
  'source_auth_failed',
  'destination_auth_failed',
  'rate_limited',
  'network_error',
  'mapping_missing',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  validation_failed: 'Validation failed',
  transform_failed: 'Transform failed',
  destination_write_failed: 'Destination write failed',
  conflict: 'Conflict',
  schema_drift: 'Schema drift detected',
  source_auth_failed: 'Source authentication failed',
  destination_auth_failed: 'Destination authentication failed',
  rate_limited: 'Rate limited by provider',
  network_error: 'Network error',
  mapping_missing: 'Field mapping missing',
};

export const ISSUE_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_STATUSES = ['open', 'retrying', 'resolved', 'skipped'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  retrying: 'Retrying',
  resolved: 'Resolved',
  skipped: 'Skipped',
};

export const REPAIR_ACTIONS = ['retry', 'replay', 'skip', 'resolve'] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

export const REPAIR_STATUSES = ['started', 'succeeded', 'failed', 'rejected'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

/** Typed phrase required before a destructive repair is accepted. */
export const DESTRUCTIVE_REPAIR_PHRASE = 'REPAIR SAFELY';

/* -------------------------------------------------------------------------- */
/* Field mapping (Part D / D4.6, D9)                                         */
/* -------------------------------------------------------------------------- */

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'json'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The transformation allow-list (Part D / D9: "Never run arbitrary code from
 * field-mapping expressions").
 *
 * These are the ONLY functions a mapping may reference. There is no evaluator
 * and no expression language: a mapping names one key from this list plus a
 * small, validated JSON config.
 */
export const TRANSFORM_TYPES = [
  'none',
  'trim',
  'uppercase',
  'lowercase',
  'to_number',
  'to_integer',
  'to_boolean',
  'to_iso_date',
  'to_iso_datetime',
  'prefix',
  'suffix',
  'concat',
  'default_if_empty',
  'split_first',
  'json_path',
  'template',
  'null_to_empty_string',
  'truncate',
] as const;
export type TransformType = (typeof TRANSFORM_TYPES)[number];

export const TRANSFORM_LABELS: Record<TransformType, string> = {
  none: 'No transform',
  trim: 'Trim whitespace',
  uppercase: 'Uppercase',
  lowercase: 'Lowercase',
  to_number: 'Convert to number',
  to_integer: 'Convert to integer',
  to_boolean: 'Convert to boolean',
  to_iso_date: 'Convert to ISO date (YYYY-MM-DD)',
  to_iso_datetime: 'Convert to ISO timestamp',
  prefix: 'Add a prefix',
  suffix: 'Add a suffix',
  concat: 'Join two values',
  default_if_empty: 'Use a default when empty',
  split_first: 'Take the first part before a separator',
  json_path: 'Read a nested value',
  template: 'Substitute into a fixed template',
  null_to_empty_string: 'Replace null with an empty string',
  truncate: 'Truncate to a maximum length',
};

/* -------------------------------------------------------------------------- */
/* Webhooks (Part D / D5)                                                     */
/* -------------------------------------------------------------------------- */

export const WEBHOOK_EVENT_STATUSES = [
  'received',
  'accepted',
  'duplicate',
  'rejected',
  'processed',
  'failed',
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Background jobs                                                            */
/* -------------------------------------------------------------------------- */

export const BACKGROUND_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

export const BACKGROUND_JOB_TYPES = [
  'sync.run',
  'sync.schedule',
  'issue.retry',
  'webhook.process',
  'notification.issue_opened',
  'maintenance.cleanup',
] as const;
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Paging                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Resource quotas per organization (Part D / D9 "resource quotas"). */
export const ORG_QUOTAS = {
  connections: 50,
  syncJobs: 100,
  webhookEndpoints: 25,
  batchSizeMax: 500,
} as const;

/**
 * How long a webhook signature timestamp may be off, in seconds.
 * Older events are rejected outright (replay protection).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** How long a per-job advisory lock is held before another worker may take it. */
export const SYNC_LOCK_TTL_MS = 10 * 60_000;