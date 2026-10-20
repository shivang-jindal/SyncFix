/**
 * Zod schemas shared between the browser and the API.
 *
 * The server always re-validates with these schemas; the client uses them for
 * inline validation. Nothing here trusts the browser (Part A / A4).
 */

import { z } from 'zod';

import {
  CONFLICT_POLICIES,
  CONNECTION_ENVIRONMENTS,
  DEFAULT_PAGE_SIZE,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  MAX_PAGE_SIZE,
  PROVIDER_KINDS,
  REST_AUTH_SCHEMES,
  RETRY_MODES,
  ROLES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  FIELD_TYPES,
  TRANSFORM_TYPES,
} from './constants.js';
import { SUPPORTED_CURRENCIES } from './money.js';

const uuid = z.string().uuid();
const _isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');
const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO 8601 timestamp');
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Expected a 3-letter ISO 4217 currency code')
  .refine((code) => SUPPORTED_CURRENCIES.includes(code), { message: 'Unsupported currency' });

export const idSchema = uuid;
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Password is too long');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const idParamSchema = z.object({ id: uuid });

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Enter your name').max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
  organizationId: uuid.optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(400),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
});

/* -------------------------------------------------------------------------- */
/* Organizations                                                              */
/* -------------------------------------------------------------------------- */

const countryCode = z.string().trim().toUpperCase().length(2, 'Use a 2-letter country code');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Enter an organization name').max(120),
  countryCode,
  timezone: z.string().trim().min(1).max(64),
  baseCurrency: currency,
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    countryCode: countryCode.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const transferOwnershipSchema = z.object({
  membershipId: uuid,
  confirmation: z.literal('TRANSFER OWNERSHIP'),
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((role) => role !== 'owner', {
    message: 'Ownership is transferred separately',
  }),
});

export const changeMemberRoleSchema = z.object({ role: z.enum(ROLES) });

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(400) });

/* -------------------------------------------------------------------------- */
/* Connections (Part D / D7)                                                  */
/* -------------------------------------------------------------------------- */

/** Credentials are write-only: accepted on input, never returned. */
export const credentialsSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().max(4000).optional(),
);

/**
 * Non-secret REST connector configuration.
 *
 * The server re-validates the protocol and resolves DNS itself; these limits
 * only give the browser fast feedback (Part D / D9).
 */
export const restSettingsSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .url('Enter a valid base URL')
      .max(500)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: 'Only http:// and https:// are allowed',
      }),
    readPathTemplate: z.string().trim().min(1).max(300).default('/{entity}'),
    writePathTemplate: z.string().trim().min(1).max(300).default('/{entity}'),
    /** How the response envelope exposes the collection and the next cursor. */
    itemsPath: z.string().trim().min(1).max(120).default('data'),
    cursorPath: z.string().trim().max(120).nullable().default(null),
    keyPath: z.string().trim().min(1).max(120).default('id'),
    versionPath: z.string().trim().max(120).nullable().default('updatedAt'),
    authScheme: z.enum(REST_AUTH_SCHEMES).default('bearer'),
    authHeaderName: z.string().trim().max(80).default('Authorization'),
    authQueryParam: z.string().trim().max(80).nullable().default(null),
    username: z.string().trim().max(200).nullable().default(null),
    extraHeaders: z.record(z.string().trim().max(60), z.string().max(500)).default({}),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
    pageSizeLimit: z.number().int().min(1).max(500).default(100),
    /** Requests per minute SyncFix will make against this connection. */
    requestsPerMinute: z.number().int().min(1).max(6_000).default(120),
  })
  .superRefine((value, ctx) => {
    if (value.authScheme === 'basic' && !value.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['username'],
        message: 'Basic authentication needs a username',
      });
    }
    if (value.authScheme === 'api_key_header' && !value.authHeaderName.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authHeaderName'],
        message: 'Name the header that carries the API key',
      });
    }
    for (const name of Object.keys(value.extraHeaders)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['extraHeaders', name],
          message: 'Header names may only contain token characters',
        });
      }
      if (/^(authorization|cookie|set-cookie|host|content-length)$/i.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['extraHeaders', name],
          message: 'This header is managed by the connector and cannot be set manually',
        });
      }
    }
  });

export type RestSettingsInput = z.infer<typeof restSettingsSchema>;

export const webhookIngestSettingsSchema = z
  .object({
    /**
     * Optional JSON pointer-ish path to the external event id inside the
     * payload. When it is missing, the payload hash is used for dedupe.
     */
    externalEventIdPath: z.string().trim().max(120).nullable().default('id'),
    /** Optional path to the entity/record name stored on the event. */
    entityPath: z.string().trim().max(120).nullable().default('entity'),
    /** Optional path to the record payload stored (redacted) on the event. */
    recordPath: z.string().trim().max(120).nullable().default('record'),
    signatureHeader: z.string().trim().min(1).max(80).default('x-syncfix-signature'),
    timestampHeader: z.string().trim().max(80).default('x-syncfix-timestamp'),
    maxPayloadBytes: z.number().int().min(1024).max(1_048_576).default(262_144),
  })
  .refine(
    (value) => !/^(authorization|cookie|host)$/i.test(value.signatureHeader),
    { message: 'Choose a different signature header', path: ['signatureHeader'] },
  );

export type WebhookIngestSettingsInput = z.infer<typeof webhookIngestSettingsSchema>;

export const createConnectionSchema = z
  .object({
    provider: z.enum(PROVIDER_KINDS),
    name: z.string().trim().min(2, 'Give the connection a name').max(120),
    environment: z.enum(CONNECTION_ENVIRONMENTS).default('production'),
    credentials: credentialsSchema.default({}),
    scopes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'rest') {
      const parsed = restSettingsSchema.safeParse(value.settings);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['settings', ...issue.path],
            message: issue.message,
          });
        }
      }
    }
    if (value.provider === 'webhook_ingest') {
      const parsed = webhookIngestSettingsSchema.safeParse(value.settings);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['settings', ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  });

export const updateConnectionSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    environment: z.enum(CONNECTION_ENVIRONMENTS).optional(),
    /** Any key present here replaces the stored credential for that key. */
    credentials: credentialsSchema.optional(),
    scopes: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const rotateConnectionSchema = z.object({
  credentials: credentialsSchema.default({}),
});

export const connectionListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  provider: z.enum(PROVIDER_KINDS).optional(),
  status: z.enum(['all', 'not_configured', 'configured', 'verified', 'error', 'disabled']).default('all'),
  sort: z.enum(['name', 'status', 'created_at', 'last_verified_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

/* -------------------------------------------------------------------------- */
/* Sync jobs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A filter expression. Deliberately a small, closed grammar - never a query
 * language and never code.
 */
export const recordFilterSchema = z
  .object({
    field: z.string().trim().min(1).max(120),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
    value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

export type RecordFilterInput = z.infer<typeof recordFilterSchema>;

export const syncMappingInputSchema = z
  .object({
    sourcePath: z.string().trim().min(1, 'Choose a source field').max(120),
    destinationPath: z.string().trim().min(1, 'Name a destination field').max(120),
    sourceType: z.enum(FIELD_TYPES).default('string'),
    destinationType: z.enum(FIELD_TYPES).default('string'),
    transformType: z.enum(TRANSFORM_TYPES).default('none'),
    transformConfig: z.record(z.string(), z.unknown()).default({}),
    required: z.boolean().default(false),
    defaultValue: z.unknown().optional(),
    sortOrder: z.number().int().min(0).max(500).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!/^[A-Za-z0-9_.\-[\]]+$/.test(value.destinationPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationPath'],
        message: 'Use letters, numbers, dots, dashes or bracket indexes',
      });
    }
    const configKeys = Object.keys(value.transformConfig);
    for (const key of configKeys) {
      if (!ALLOWED_TRANSFORM_CONFIG_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transformConfig', key],
          message: `"${key}" is not a recognised transform option`,
        });
      }
    }
    const requiredByTransform = REQUIRED_TRANSFORM_CONFIG[value.transformType];
    if (requiredByTransform) {
      for (const key of requiredByTransform) {
        if (value.transformConfig[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transformConfig', key],
            message: `The ${value.transformType} transform needs a "${key}" option`,
          });
        }
      }
    }
  });

export type SyncMappingInput = z.infer<typeof syncMappingInputSchema>;

/** Closed set of transform config keys; anything else is rejected. */
export const ALLOWED_TRANSFORM_CONFIG_KEYS = new Set([
  'value',
  'prefix',
  'suffix',
  'separator',
  'delimiter',
  'default',
  'path',
  'template',
  'maxLength',
  'secondaryPath',
]);

/** Which keys each transform requires. Mirrored by the server validator. */
export const REQUIRED_TRANSFORM_CONFIG: Partial<Record<(typeof TRANSFORM_TYPES)[number], string[]>> = {
  prefix: ['value'],
  suffix: ['value'],
  default_if_empty: ['value'],
  split_first: ['delimiter'],
  json_path: ['path'],
  template: ['template'],
  truncate: ['maxLength'],
  concat: ['value', 'secondaryPath'],
};

export const retryPolicySchema = z
  .object({
    mode: z.enum(RETRY_MODES).default('safe_only'),
    maxAttempts: z.number().int().min(0).max(10).default(3),
    backoffSeconds: z.number().int().min(0).max(3600).default(60),
  })
  .strict();

export type RetryPolicyInput = z.infer<typeof retryPolicySchema>;

export const createSyncJobSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the job a name').max(120),
    sourceConnectionId: uuid,
    destinationConnectionId: uuid,
    sourceEntity: z.string().trim().min(1, 'Choose a source entity').max(120),
    destinationEntity: z.string().trim().min(1, 'Name a destination entity').max(120),
    conflictPolicy: z.enum(CONFLICT_POLICIES),
    scheduleCron: z
      .string()
      .trim()
      .max(120)
      .refine((value) => value === '' || /^[0-9*/,\- ]{5,120}$/.test(value), {
        message: 'Enter a cron expression such as "*/15 * * * *"',
      })
      .nullable()
      .default(null),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    batchSize: z.number().int().min(1).max(500).default(50),
    retryPolicy: retryPolicySchema.default({ mode: 'safe_only', maxAttempts: 3, backoffSeconds: 60 }),
    filters: z.array(recordFilterSchema).max(20).default([]),
    mappings: z.array(syncMappingInputSchema).max(200).default([]),
    /**
     * Every job is created paused. Enabling the schedule is a separate,
     * explicit action (Part D / D10: "No sync job runs without an explicit
     * enable action").
     */
    startPaused: z.literal(true).default(true),
  })
  .refine((value) => value.sourceConnectionId !== value.destinationConnectionId || true, {
    message: 'Source and destination may be the same connection',
  });

export const updateSyncJobSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    sourceEntity: z.string().trim().min(1).max(120).optional(),
    destinationEntity: z.string().trim().min(1).max(120).optional(),
    conflictPolicy: z.enum(CONFLICT_POLICIES).optional(),
    scheduleCron: z.string().trim().max(120).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    batchSize: z.number().int().min(1).max(500).optional(),
    retryPolicy: retryPolicySchema.optional(),
    filters: z.array(recordFilterSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const jobListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'paused', 'enabled']).default('all'),
  sort: z.enum(['name', 'created_at', 'last_run_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const runListQuerySchema = paginationSchema.extend({
  status: z.enum(['all', ...RUN_STATUSES]).default('all'),
  trigger: z.enum(['all', ...RUN_TRIGGERS]).default('all'),
  sort: z.enum(['started_at', 'finished_at', 'duration_ms']).default('started_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/* -------------------------------------------------------------------------- */
/* Issues and repair                                                          */
/* -------------------------------------------------------------------------- */

export const issueListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  syncJobId: uuid.optional(),
  issueType: z.enum(['all', ...ISSUE_TYPES]).default('all'),
  severity: z.enum(['all', ...ISSUE_SEVERITIES]).default('all'),
  status: z.enum(['all', ...ISSUE_STATUSES]).default('all'),
  firstSeenFrom: isoTimestamp.optional(),
  firstSeenTo: isoTimestamp.optional(),
  sort: z.enum(['last_seen_at', 'first_seen_at', 'severity', 'attempt_count']).default('last_seen_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const retryIssueSchema = z.object({
  /** Set for "replay": re-fetch this record from the source. */
  replayFromSource: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});

export const skipIssueSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason for skipping').max(500),
});

export const resolveIssueSchema = z.object({
  reason: z.string().trim().min(3, 'Describe what you did').max(500),
  /** Required only when the repair was destructive. */
  confirmation: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(2, 'Give the endpoint a name').max(120),
  enabled: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateWebhookEndpointSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

export const overviewQuerySchema = z
  .object({
    from: isoTimestamp.optional(),
    to: isoTimestamp.optional(),
  })
  .refine((value) => !value.from || !value.to || value.to >= value.from, {
    message: 'The end of the window cannot be before its start',
    path: ['to'],
  });

export const syncHealthQuerySchema = overviewQuerySchema;

export const auditQuerySchema = paginationSchema.extend({
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().trim().max(80).optional(),
  action: z.string().trim().max(80).optional(),
});

export const updateSyncSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  issueNotificationEmails: z.array(emailSchema).max(20).optional(),
  notifyOnSeverity: z.enum(ISSUE_SEVERITIES).optional(),
  redactFields: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
});

export const schemaCatalog = {
  register: registerSchema,
  login: loginSchema,
  createOrganization: createOrganizationSchema,
  createConnection: createConnectionSchema,
  createSyncJob: createSyncJobSchema,
  createWebhookEndpoint: createWebhookEndpointSchema,
  retryIssue: retryIssueSchema,
};