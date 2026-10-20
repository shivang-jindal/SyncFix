/**
 * API contract types (Part A / A7).
 *
 * Every list endpoint returns `Paginated<T>`; every error returns `ApiError`.
 */

import type {
  ConflictPolicy,
  ConnectionEnvironment,
  ConnectionStatus,
  FieldType,
  IssueSeverity,
  IssueStatus,
  IssueType,
  JobStatus,
  ProviderKind,
  Role,
  RunStatus,
  RunStepName,
  RunTrigger,
  SyncMode,
  SyncRecordStatus,
  TransformType,
  WebhookEventStatus,
} from './constants.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTEGRATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiFieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string[]>;
    issues?: ApiFieldIssue[];
    requestId: string;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  baseCurrency: string;
  timezone: string;
  role: Role;
  permissions: string[];
}

export interface AuthSessionResponse {
  user: SessionUser;
  memberships: MembershipSummary[];
  activeOrganizationId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Connections                                                                */
/* -------------------------------------------------------------------------- */

/** A connection as returned to the browser. Credentials are NEVER included. */
export interface ConnectionListItem {
  id: string;
  provider: string;
  providerKind: ProviderKind;
  name: string;
  environment: ConnectionEnvironment;
  status: ConnectionStatus;
  /** Keys that have a stored credential, with a mask. Never the value. */
  credentialMasks: Array<{ key: string; masked: string | null }>;
  scopes: string[];
  /** Non-secret connection settings (endpoints, pagination style...). */
  settings: Record<string, unknown>;
  supportsWrite: boolean;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionTestRun {
  id: string;
  connectionId: string;
  status: 'passed' | 'failed';
  testedAt: string;
  latencyMs: number | null;
  errorCode: string | null;
  safeMessage: string;
}

export interface ProviderDescriptor {
  provider: string;
  kind: ProviderKind;
  displayName: string;
  /** True only when the adapter is implemented, tested and usable. */
  available: boolean;
  description: string;
  authOptions: string[];
  supportsWrite: boolean;
  /** Exactly what the adapter guarantees. */
  guarantees: string[];
  limitations: string[];
  setupSteps: string[];
  docsUrl?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Sync jobs                                                                  */
/* -------------------------------------------------------------------------- */

export interface SyncJobListItem {
  id: string;
  name: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  destinationConnectionId: string;
  destinationConnectionName: string;
  sourceEntity: string;
  destinationEntity: string;
  mode: SyncMode;
  scheduleCron: string | null;
  timezone: string;
  status: JobStatus;
  conflictPolicy: ConflictPolicy;
  batchSize: number;
  /** Explicitly distinguishes "never ran" from "always succeeded". */
  lastRun: RunSummary | null;
  successRate: RateSummary;
  openIssueCount: number;
  schemaDrift: SchemaDriftSummary;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
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

export interface RateSummary {
  /** Denominator: finished runs inside the window. Zero means "no runs yet". */
  successfulRuns: number;
  failedRuns: number;
  partialRuns: number;
  totalRuns: number;
  windowLabel: string;
  /** null when there were no runs in the window - never a fake 100%. */
  successRatePercent: number | null;
}

export interface SchemaDriftSummary {
  detected: boolean;
  unknownSourceFields: string[];
  lastDetectedAt: string | null;
  lastRunId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export interface RunStepView {
  id: string;
  stepName: RunStepName;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
  errorCode: string | null;
  safeMessage: string | null;
}

export interface RunDetail extends RunSummary {
  syncJobId: string;
  syncJobName: string;
  cursorStart: Record<string, unknown> | null;
  cursorEnd: Record<string, unknown> | null;
  requestId: string | null;
  dryRun: boolean;
  steps: RunStepView[];
  errorCategories: Array<{ errorCode: string; count: number }>;
  notes: string[];
  retryableFailureCount: number;
}

/* -------------------------------------------------------------------------- */
/* Records and issues                                                         */
/* -------------------------------------------------------------------------- */

export interface SyncRecordView {
  id: string;
  syncJobId: string;
  sourceRecordKey: string;
  destinationRecordKey: string | null;
  sourceVersion: string | null;
  destinationVersion: string | null;
  status: SyncRecordStatus;
  lastSyncedAt: string | null;
  lastHash: string | null;
  createdAt: string;
}

export interface IssueListItem {
  id: string;
  syncJobId: string;
  syncJobName: string;
  syncRunId: string | null;
  recordKey: string | null;
  issueType: IssueType;
  severity: IssueSeverity;
  status: IssueStatus;
  errorCode: string | null;
  safeMessage: string;
  attemptCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  /** False when the destination write is not idempotent and no safety strategy exists. */
  canRetry: boolean;
  retryBlockedReason: string | null;
}

export interface RepairAttemptView {
  id: string;
  issueId: string;
  action: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  resultSummary: Record<string, unknown> | null;
  initiatedBy: string | null;
}

export interface IssueDetail extends IssueListItem {
  redactedPayload: Record<string, unknown> | null;
  repairedPayload: Record<string, unknown> | null;
  probableNextStep: string;
  repairAttempts: RepairAttemptView[];
  record: SyncRecordView | null;
}

/* -------------------------------------------------------------------------- */
/* Field mappings                                                             */
/* -------------------------------------------------------------------------- */

export interface SyncMappingView {
  id: string;
  syncJobId: string;
  sourcePath: string;
  destinationPath: string;
  sourceType: FieldType;
  destinationType: FieldType;
  transformType: TransformType;
  transformConfig: Record<string, unknown>;
  required: boolean;
  defaultValue: unknown;
  sortOrder: number;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface WebhookEndpointView {
  id: string;
  name: string;
  publicEndpointId: string;
  /** Fully-qualified URL. The secret is never part of it. */
  url: string;
  enabled: boolean;
  /** True only for the creation/rotation response, never on a read. */
  secret?: string;
  lastReceivedAt: string | null;
  eventCount: number;
  createdAt: string;
}

export interface WebhookEventView {
  id: string;
  endpointId: string;
  endpointName: string;
  externalEventId: string | null;
  payloadHash: string;
  status: WebhookEventStatus;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
  redactedPayload: Record<string, unknown> | null;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

export interface OverviewSummary {
  windowLabel: string;
  from: string;
  to: string;
  activeJobs: number;
  pausedJobs: number;
  successfulRuns: number;
  failedRuns: number;
  partialRuns: number;
  /** null when nothing ran in the window. */
  successRatePercent: number | null;
  openIssues: number;
  criticalIssues: number;
  recordsProcessed: number;
  lastSyncAt: string | null;
  connectionsVerified: number;
  connectionsNeedingAttention: number;
  jobHealth: Array<{
    syncJobId: string;
    name: string;
    status: JobStatus;
    successRate: RateSummary;
    openIssues: number;
    lastRunAt: string | null;
  }>;
  topErrors: Array<{ errorCode: string; issueCount: number }>;
}

export interface SyncHealthReport {
  windowLabel: string;
  from: string;
  to: string;
  totals: {
    runs: number;
    succeeded: number;
    partial: number;
    failed: number;
    fetched: number;
    written: number;
    failedRecords: number;
    /** null when there were no runs in the window. */
    successRatePercent: number | null;
    medianDurationMs: number | null;
  };
  byJob: Array<{
    syncJobId: string;
    name: string;
    status: JobStatus;
    runs: number;
    succeeded: number;
    partial: number;
    failed: number;
    successRatePercent: number | null;
    lastRunAt: string | null;
    openIssues: number;
  }>;
  recurringErrors: Array<{ errorCode: string; count: number; jobCount: number; lastSeenAt: string }>;
}