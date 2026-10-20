/**
 * SyncFix database schema (Part D / D6).
 *
 * - UUID primary keys, `timestamptz` UTC timestamps.
 * - Every tenant-owned table carries `organization_id` and is indexed on it.
 * - Shared foundation tables (organizations, users, memberships, audit events,
 *   background jobs) match the Part A contract used across all five products.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const now = sql`now()`;

/* -------------------------------------------------------------------------- */
/* Shared foundation                                                          */
/* -------------------------------------------------------------------------- */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    countryCode: text('country_code').notNull().default('US'),
    timezone: text('timezone').notNull().default('UTC'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('memberships_org_user_idx').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

/** Opaque session tokens are stored only as SHA-256 hashes. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    activeOrganizationId: uuid('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),
    index('invitations_org_idx').on(table.organizationId),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('password_reset_token_hash_idx').on(table.tokenHash)],
);

/**
 * Per-organization settings. SyncFix keeps retention, notification and redaction
 * policy here rather than on the organization row so the organization table
 * stays identical to the other products.
 */
export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** How long run/issue detail is kept before the cleanup job removes it. */
  retentionDays: integer('retention_days').notNull().default(90),
  /** Email addresses notified when an issue is opened. Empty = in-app only. */
  issueNotificationEmails: jsonb('issue_notification_emails_json')
    .$type<string[]>()
    .notNull()
    .default([]),
  notifyOnSeverity: text('notify_on_severity').notNull().default('critical'),
  /** Field names redacted in every stored payload, diff and log line. */
  redactFields: jsonb('redact_fields_json')
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata_json').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().default(now),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('background_jobs_claim_idx').on(table.status, table.runAfter),
    index('background_jobs_org_idx').on(table.organizationId, table.createdAt),
    uniqueIndex('background_jobs_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const emailTemplates = pgTable('email_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  subject: text('subject').notNull(),
  bodyHtml: text('body_html').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    templateType: text('template_type').notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text'),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    idempotencyKey: text('idempotency_key'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('email_messages_org_status_idx').on(table.organizationId, table.status),
    uniqueIndex('email_messages_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Connections (Part D / D6)                                                  */
/* -------------------------------------------------------------------------- */

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** One of the implemented adapter kinds: `rest` | `webhook_ingest`. */
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    environment: text('environment').notNull().default('production'),
    status: text('status').notNull().default('not_configured'),
    /**
     * AES-256-GCM sealed credentials. The plaintext is never returned by any
     * API response and never logged (Part D / D3, D9).
     */
    encryptedCredentials: text('encrypted_credentials_json'),
    /** Non-secret adapter configuration (endpoints, paths, auth scheme). */
    settings: jsonb('settings_json').$type<Record<string, unknown>>().notNull().default({}),
    /** Keys present in the sealed credential blob, for the masked UI. */
    credentialKeys: jsonb('credential_keys_json').$type<string[]>().notNull().default([]),
    scopes: jsonb('scopes_json').$type<string[]>().notNull().default([]),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('connections_org_status_idx').on(table.organizationId, table.status),
    index('connections_org_provider_idx').on(table.organizationId, table.provider),
  ],
);

export const connectionTestRuns = pgTable(
  'connection_test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    testedAt: timestamp('tested_at', { withTimezone: true }).notNull().default(now),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    /** Operator-facing explanation. Never contains a credential. */
    safeMessage: text('safe_message').notNull().default(''),
  },
  (table) => [
    index('connection_test_runs_connection_idx').on(table.connectionId, table.testedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Sync jobs and mappings (Part D / D6)                                       */
/* -------------------------------------------------------------------------- */

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceConnectionId: uuid('source_connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    destinationConnectionId: uuid('destination_connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    sourceEntity: text('source_entity').notNull(),
    destinationEntity: text('destination_entity').notNull(),
    /** v1 is one-way only; the column exists so the mode is explicit. */
    mode: text('mode').notNull().default('one_way'),
    scheduleCron: text('schedule_cron'),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(false),
    conflictPolicy: text('conflict_policy').notNull().default('manual_review'),
    batchSize: integer('batch_size').notNull().default(50),
    retryPolicy: jsonb('retry_policy_json')
      .$type<{ mode: string; maxAttempts: number; backoffSeconds: number }>()
      .notNull()
      .default({ mode: 'safe_only', maxAttempts: 3, backoffSeconds: 60 }),
    filters: jsonb('filters_json')
      .$type<Array<{ field: string; operator: string; value?: unknown }>>()
      .notNull()
      .default([]),
    /**
     * The resume position. Only written after the batch it describes is
     * committed (Part D / D9).
     */
    checkpoint: jsonb('checkpoint_json').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('sync_jobs_org_enabled_idx').on(table.organizationId, table.enabled),
    index('sync_jobs_org_name_idx').on(table.organizationId, table.name),
  ],
);

export const syncMappings = pgTable(
  'sync_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncJobId: uuid('sync_job_id')
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    destinationPath: text('destination_path').notNull(),
    sourceType: text('source_type').notNull().default('string'),
    destinationType: text('destination_type').notNull().default('string'),
    /** One key of the TRANSFORM_TYPES allow-list - never an expression. */
    transformType: text('transform_type').notNull().default('none'),
    transformConfig: jsonb('transform_config_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    required: boolean('required').notNull().default(false),
    defaultValue: jsonb('default_value_json'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('sync_mappings_job_idx').on(table.syncJobId, table.sortOrder),
    uniqueIndex('sync_mappings_job_destination_idx').on(table.syncJobId, table.destinationPath),
  ],
);

/* -------------------------------------------------------------------------- */
/* Runs (Part D / D6)                                                         */
/* -------------------------------------------------------------------------- */

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncJobId: uuid('sync_job_id')
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    triggerType: text('trigger_type').notNull(),
    status: text('status').notNull().default('queued'),
    dryRun: boolean('dry_run').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(now),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    fetchedCount: integer('fetched_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    cursorStart: jsonb('cursor_start_json').$type<Record<string, unknown>>(),
    cursorEnd: jsonb('cursor_end_json').$type<Record<string, unknown>>(),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    safeMessage: text('safe_message'),
    requestId: text('request_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('sync_runs_job_started_idx').on(table.syncJobId, table.startedAt),
    index('sync_runs_org_started_idx').on(table.organizationId, table.startedAt),
    index('sync_runs_org_status_idx').on(table.organizationId, table.status),
  ],
);

export const syncRunSteps = pgTable(
  'sync_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),
    stepName: text('step_name').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(now),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    counts: jsonb('counts_json').$type<Record<string, number>>().notNull().default({}),
    errorCode: text('error_code'),
    safeMessage: text('safe_message'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [index('sync_run_steps_run_idx').on(table.syncRunId, table.sortOrder)],
);

/* -------------------------------------------------------------------------- */
/* Records and issues (Part D / D6)                                           */
/* -------------------------------------------------------------------------- */

/**
 * One row per source record a job has ever processed. The unique index is what
 * makes an idempotent retry safe: the same source key can never produce two
 * destination rows.
 */
export const syncRecords = pgTable(
  'sync_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncJobId: uuid('sync_job_id')
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    sourceRecordKey: text('source_record_key').notNull(),
    destinationRecordKey: text('destination_record_key'),
    sourceVersion: text('source_version'),
    destinationVersion: text('destination_version'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Stable hash of the normalised source payload; drives change detection. */
    lastHash: text('last_hash'),
    status: text('status').notNull().default('synced'),
    redactedSource: jsonb('redacted_source_json').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('sync_records_job_source_key_idx').on(table.syncJobId, table.sourceRecordKey),
    index('sync_records_job_status_idx').on(table.syncJobId, table.status),
  ],
);

export const syncIssues = pgTable(
  'sync_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncJobId: uuid('sync_job_id')
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    recordKey: text('record_key'),
    issueType: text('issue_type').notNull(),
    severity: text('severity').notNull().default('warning'),
    status: text('status').notNull().default('open'),
    errorCode: text('error_code'),
    safeMessage: text('safe_message').notNull().default(''),
    redactedPayload: jsonb('redacted_payload_json').$type<Record<string, unknown>>(),
    repairedPayload: jsonb('repaired_payload_json').$type<Record<string, unknown>>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    /**
     * False when the destination write is not idempotent and no safety
     * strategy exists. The API refuses to offer "retry" in that case
     * (Part D / D5).
     */
    retryable: boolean('retryable').notNull().default(true),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().default(now),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().default(now),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolutionReason: text('resolution_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('sync_issues_org_status_idx').on(table.organizationId, table.status),
    index('sync_issues_job_status_idx').on(table.syncJobId, table.status),
    index('sync_issues_last_seen_idx').on(table.organizationId, table.lastSeenAt),
    index('sync_issues_record_idx').on(table.syncJobId, table.recordKey),
  ],
);

export const repairAttempts = pgTable(
  'repair_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => syncIssues.id, { onDelete: 'cascade' }),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    status: text('status').notNull().default('started'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(now),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    resultSummary: jsonb('result_summary_json').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    safeMessage: text('safe_message'),
  },
  (table) => [index('repair_attempts_issue_idx').on(table.issueId, table.startedAt)],
);

/* -------------------------------------------------------------------------- */
/* Webhook ingestion (Part D / D6)                                             */
/* -------------------------------------------------------------------------- */

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Public, unguessable path segment. Safe to show. */
    publicEndpointId: text('public_endpoint_id').notNull(),
    /**
     * AES-256-GCM sealed HMAC secret. Verification decrypts it; the plaintext
     * is returned exactly once at creation and at rotation, and never stored
     * in clear text or written to a log.
     */
    encryptedSecret: text('encrypted_secret'),
    enabled: boolean('enabled').notNull().default(true),
    settings: jsonb('settings_json').$type<Record<string, unknown>>().notNull().default({}),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('webhook_endpoints_public_id_idx').on(table.publicEndpointId),
    index('webhook_endpoints_org_idx').on(table.organizationId),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    /** Supplied by the sender; dedupe key when present. */
    externalEventId: text('external_event_id'),
    /** SHA-256 of the exact raw body. Always present. */
    payloadHash: text('payload_hash').notNull(),
    redactedPayload: jsonb('redacted_payload_json').$type<Record<string, unknown>>(),
    status: text('status').notNull().default('received'),
    errorCode: text('error_code'),
    safeMessage: text('safe_message'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(now),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    // Dedupe: the same external event id can never be processed twice.
    uniqueIndex('webhook_events_endpoint_external_idx')
      .on(table.endpointId, table.externalEventId)
      .where(sql`${table.externalEventId} is not null`),
    // ...and a replay with the same body is caught even without an event id.
    uniqueIndex('webhook_events_endpoint_hash_idx')
      .on(table.endpointId, table.payloadHash)
      .where(sql`${table.externalEventId} is null`),
    index('webhook_events_org_received_idx').on(table.organizationId, table.receivedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Locks and rate limits (Part D / D6)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Per-job advisory lock. At most one row may exist per job, so a scheduled run
 * can never overlap a manual one (Part D / D9). An expired lock is reclaimable.
 */
export const syncLocks = pgTable(
  'sync_locks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    syncJobId: uuid('sync_job_id')
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    ownerToken: text('owner_token').notNull(),
    runId: uuid('run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().default(now),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('sync_locks_job_idx').on(table.syncJobId),
    index('sync_locks_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Per-organization, per-connection request accounting. The worker refuses to
 * exceed the configured budget instead of hammering a provider (Part D / D9).
 */
export const integrationRateLimits = pgTable(
  'integration_rate_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('integration_rate_limits_window_idx').on(
      table.connectionId,
      table.windowStart,
    ),
    index('integration_rate_limits_org_idx').on(table.organizationId, table.windowStart),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  connections: many(connections),
  syncJobs: many(syncJobs),
  settings: many(organizationSettings),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const connectionsRelations = relations(connections, ({ many }) => ({
  testRuns: many(connectionTestRuns),
  rateLimits: many(integrationRateLimits),
}));

export const syncJobsRelations = relations(syncJobs, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [syncJobs.organizationId],
    references: [organizations.id],
  }),
  sourceConnection: one(connections, {
    fields: [syncJobs.sourceConnectionId],
    references: [connections.id],
    relationName: 'sync_job_source',
  }),
  destinationConnection: one(connections, {
    fields: [syncJobs.destinationConnectionId],
    references: [connections.id],
    relationName: 'sync_job_destination',
  }),
  mappings: many(syncMappings),
  runs: many(syncRuns),
  records: many(syncRecords),
  issues: many(syncIssues),
}));

export const syncRunsRelations = relations(syncRuns, ({ many, one }) => ({
  job: one(syncJobs, { fields: [syncRuns.syncJobId], references: [syncJobs.id] }),
  steps: many(syncRunSteps),
}));

export const syncIssuesRelations = relations(syncIssues, ({ many, one }) => ({
  job: one(syncJobs, { fields: [syncIssues.syncJobId], references: [syncJobs.id] }),
  repairs: many(repairAttempts),
}));

/* -------------------------------------------------------------------------- */
/* Row types                                                                  */
/* -------------------------------------------------------------------------- */

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type ConnectionTestRun = typeof connectionTestRuns.$inferSelect;
export type SyncJob = typeof syncJobs.$inferSelect;
export type SyncMapping = typeof syncMappings.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type SyncRunStep = typeof syncRunSteps.$inferSelect;
export type SyncRecord = typeof syncRecords.$inferSelect;
export type SyncIssue = typeof syncIssues.$inferSelect;
export type RepairAttempt = typeof repairAttempts.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type SyncLock = typeof syncLocks.$inferSelect;
export type IntegrationRateLimit = typeof integrationRateLimits.$inferSelect;