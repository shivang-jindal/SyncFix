/**
 * Generic REST connector (Part D / D8 "first release").
 *
 * This adapter is fully implemented and covered by tests. It talks to ONE
 * explicitly configured, documented base URL per connection. Every request is
 * made through `safeFetch`, which enforces the SSRF protections in Part D / D9:
 * protocol allow-list, DNS validation, private/reserved/metadata address
 * blocking, redirect re-validation, timeouts and a response size cap.
 *
 * Guarantees
 * ----------
 * - Reads use `GET` with an opaque cursor read from the configured
 *   `cursorPath`, so pagination is exact and resumable.
 * - Writes use `PUT`. `PUT` is idempotent by HTTP definition, so a retried
 *   write cannot create a second record.
 * - An idempotency key is sent as the `Idempotency-Key` header and as a query
 *   parameter, so a destination supporting either can dedupe.
 * - A write is only reported as confirmed when the destination answered 2xx
 *   AND returned the record key at `keyPath`. Anything else is
 *   `confirmed: false`, and the engine turns that into an issue rather than a
 *   success (Part D / "never claim a destination write succeeded unless the
 *   adapter confirmed it").
 *
 * Limitations (surfaced verbatim in the UI)
 * -----------------------------------------
 * - The destination must expose a PUT-by-key endpoint. Systems that only offer
 *   POST-create cannot be safely retried and are NOT supported here.
 * - No delta/incremental cursor is inferred; the cursor is whatever the
 *   response advertises.
 * - No transaction support: a run is at-least-once, made effectively-once by
 *   the idempotency key and the per-job lock.
 */

import {
  restSettingsSchema,
  type RestSettingsInput,
} from '@syncfix/shared';

import { SsrfBlockedError, safeFetch, validateUrlShape } from '../lib/safe-fetch.js';
import { collectFieldNames, safeUrlLabel } from '../lib/redact.js';
import {
  AdapterError,
  UnsupportedOperationError,
  type AdapterContext,
  type AdapterEntity,
  type AdapterPage,
  type AdapterRecord,
  type ConnectorAdapter,
  type NormalizedAdapterError,
  type RateLimitState,
  type TestConnectionResult,
  type UpsertResult,
} from './types.js';

const MAX_RESPONSE_BYTES = 1_048_576;
/** Entity name used to probe the configured path templates during a test. */
const PROBE_ENTITY = 'default';

export interface RestAdapterOptions {
  /**
   * Per-entity baseline of field names SyncFix has previously observed. Any
   * field outside this baseline is reported as schema drift instead of being
   * silently dropped.
   */
  knownFields?: Record<string, string[]>;
}

export class RestConnectorAdapter implements ConnectorAdapter {
  readonly provider = 'rest';
  readonly kind = 'rest' as const;
  readonly displayName = 'Generic REST API';
  readonly capabilities = {
    supportsWrite: true,
    supportsGetRecord: true,
    supportsRateLimitState: true,
  } as const;

  readonly guarantees = [
    'Reads use HTTP GET with an opaque cursor taken from the configured cursor path.',
    'Writes use HTTP PUT, which is idempotent by definition.',
    'Every write carries an Idempotency-Key header and query parameter.',
    'A write is only reported as successful when the destination returned 2xx and the record key.',
    'Every request is re-validated against private, loopback, link-local, reserved and cloud-metadata addresses, and redirects are re-checked.',
  ];

  readonly limitations = [
    'The destination must offer an idempotent PUT-by-key endpoint. POST-only APIs are not supported.',
    'No transactional writes: a run is at-least-once, made effectively-once by the idempotency key.',
    'Schema drift is only detected for fields observed on records SyncFix actually fetches.',
    'Rate limits are enforced locally from your configured budget; SyncFix does not discover the provider quota.',
  ];

  readonly setupSteps = [
    'Create a connection with provider "Generic REST API".',
    'Enter the public https:// base URL of the system you want to read from or write to.',
    'Configure the read/write path templates, for example /v1/{entity}.',
    'Describe how the response envelope exposes records (items path), the next cursor (cursor path) and the record key (key path).',
    'Add a credential: a bearer token, an API key header or basic auth. Credentials are encrypted at rest and never shown again.',
    'Run Test connection. Nothing is called connected until this test succeeds.',
  ];

  constructor(private readonly options: RestAdapterOptions = {}) {}

  /* ------------------------------------------------------------------ */
  /* Settings and request construction                                   */
  /* ------------------------------------------------------------------ */

  private settings(ctx: AdapterContext): RestSettingsInput {
    const parsed = restSettingsSchema.safeParse(ctx.settings);
    if (!parsed.success) {
      throw new AdapterError({
        kind: 'unsupported',
        code: 'invalid_configuration',
        message: 'This connection is missing a valid REST configuration. Edit it and test again.',
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    return parsed.data;
  }

  /**
   * Joins a path template onto the validated base URL. The scheme and host are
   * always taken from the already-validated base, so a template can never
   * redirect the request to another origin.
   */
  private buildUrl(
    ctx: AdapterContext,
    template: string,
    entity: string,
    query: Record<string, string | undefined>,
  ): string {
    const settings = this.settings(ctx);
    const base = validateUrlShape(settings.baseUrl);
    const rendered = template
      .replaceAll('{entity}', encodeURIComponent(entity))
      .replaceAll('{id}', encodeURIComponent(entity));
    const target = new URL(rendered.startsWith('/') ? rendered : `/${rendered}`, base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    return target.toString();
  }

  private headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    const settings = this.settings(ctx);
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    for (const [name, value] of Object.entries(settings.extraHeaders)) {
      headers[name] = value;
    }
    switch (settings.authScheme) {
      case 'bearer':
        if (ctx.credentials.token) headers.authorization = `Bearer ${ctx.credentials.token}`;
        break;
      case 'api_key_header':
        if (ctx.credentials.apiKey) {
          headers[settings.authHeaderName.toLowerCase()] = ctx.credentials.apiKey;
        }
        break;
      case 'basic':
        if (ctx.credentials.username) {
          const raw = `${ctx.credentials.username}:${ctx.credentials.password ?? ''}`;
          headers.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
        }
        break;
      case 'none':
      default:
        break;
    }
    return headers;
  }

  /* ------------------------------------------------------------------ */
  /* HTTP                                                                */
  /* ------------------------------------------------------------------ */

  private async request(
    ctx: AdapterContext,
    url: string,
    init: { method?: 'GET' | 'PUT'; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const settings = this.settings(ctx);
    await ctx.consumeQuota();

    let result;
    try {
      result = await safeFetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.body !== undefined ? { body: init.body } : {}),
        timeoutMs: settings.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      throw new AdapterError(this.normalizeError(error));
    }

    let parsed: unknown = null;
    if (result.body.trim()) {
      try {
        parsed = JSON.parse(result.body);
      } catch {
        throw new AdapterError({
          kind: 'invalid_response',
          code: 'invalid_json',
          message: `${safeUrlLabel(url)} did not return valid JSON.`,
          retryable: false,
          status: result.status,
          retryAfterSeconds: null,
        });
      }
    }

    if (result.status === 401 || result.status === 403) {
      throw new AdapterError({
        kind: result.status === 401 ? 'auth' : 'forbidden',
        code: result.status === 401 ? 'unauthorized' : 'forbidden',
        message:
          result.status === 401
            ? `${safeUrlLabel(url)} rejected the stored credential (HTTP 401). Rotate it and test again.`
            : `${safeUrlLabel(url)} returned HTTP 403. The credential lacks the required scope.`,
        retryable: false,
        status: result.status,
        retryAfterSeconds: null,
      });
    }
    if (result.status === 429) {
      const retryAfter = Number(result.headers['retry-after'] ?? '0');
      throw new AdapterError({
        kind: 'rate_limited',
        code: 'rate_limited',
        message: `${safeUrlLabel(url)} is rate limiting this connection (HTTP 429).`,
        retryable: true,
        status: 429,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      });
    }
    if (result.status === 404) {
      throw new AdapterError({
        kind: 'not_found',
        code: 'not_found',
        message: `${safeUrlLabel(url)} returned HTTP 404. Check the path template.`,
        retryable: false,
        status: 404,
        retryAfterSeconds: null,
      });
    }
    if (result.status >= 500) {
      throw new AdapterError({
        kind: 'network',
        code: 'server_error',
        message: `${safeUrlLabel(url)} returned HTTP ${result.status}. This is usually temporary.`,
        retryable: true,
        status: result.status,
        retryAfterSeconds: null,
      });
    }
    if (result.status >= 400) {
      throw new AdapterError({
        kind: 'validation',
        code: 'client_error',
        message: `${safeUrlLabel(url)} rejected the request (HTTP ${result.status}).`,
        retryable: false,
        status: result.status,
        retryAfterSeconds: null,
      });
    }

    return { status: result.status, headers: result.headers, body: parsed };
  }

  /* ------------------------------------------------------------------ */
  /* Adapter contract                                                    */
  /* ------------------------------------------------------------------ */

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    const startedAt = Date.now();
    let label = '(unconfigured endpoint)';
    try {
      const settings = this.settings(ctx);
      label = safeUrlLabel(settings.baseUrl);
      const url = this.buildUrl(ctx, settings.readPathTemplate, PROBE_ENTITY, { limit: '1' });
      const response = await this.request(ctx, url, { headers: this.headers(ctx) });
      const page = this.parsePage(response.body, settings);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        message: `Reached ${label} and parsed a valid response envelope.`,
        entities: [
          {
            key: PROBE_ENTITY,
            displayName: PROBE_ENTITY,
            description: `Read from ${label}${settings.readPathTemplate.replace('{entity}', '')}`,
            sampleFields: page.records[0]
              ? [...collectFieldNames(page.records[0].payload)].slice(0, 25)
              : [],
          },
        ],
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        errorCode: normalized.code,
        message: normalized.message,
      };
    }
  }

  async listSupportedEntities(ctx: AdapterContext): Promise<AdapterEntity[]> {
    const settings = this.settings(ctx);
    const test = await this.testConnection(ctx);
    if (!test.ok) {
      throw new AdapterError({
        kind: 'unknown',
        code: test.errorCode ?? 'probe_failed',
        message: test.message,
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    return (
      test.entities ?? [
        {
          key: PROBE_ENTITY,
          displayName: PROBE_ENTITY,
          description: `Configured from the path templates of ${safeUrlLabel(settings.baseUrl)}`,
        },
      ]
    );
  }

  async fetchPage(
    ctx: AdapterContext,
    entity: string,
    cursor: string | null,
    limit: number,
  ): Promise<AdapterPage> {
    const settings = this.settings(ctx);
    const effectiveLimit = Math.min(Math.max(1, limit), settings.pageSizeLimit);
    const url = this.buildUrl(ctx, settings.readPathTemplate, entity, {
      limit: String(effectiveLimit),
      ...(cursor ? { cursor } : {}),
    });
    const response = await this.request(ctx, url, { headers: this.headers(ctx) });
    const page = this.parsePage(response.body, settings);

    const baseline = this.options.knownFields?.[entity];
    if (!baseline) return page;

    const observed = new Set<string>();
    for (const record of page.records) {
      for (const name of collectFieldNames(record.payload)) observed.add(name);
    }
    const unknownFields = [...observed].filter((name) => !baseline.includes(name)).sort();
    return { ...page, unknownFields };
  }

  async getRecord(ctx: AdapterContext, entity: string, key: string): Promise<AdapterRecord | null> {
    const settings = this.settings(ctx);
    const template = settings.readPathTemplate.includes('{id}')
      ? settings.readPathTemplate
      : `${settings.readPathTemplate.replace(/\/$/, '')}/{id}`;
    const url = this.buildUrl(ctx, template, entity, {});
    const target = url.replace(/\{id\}$/, encodeURIComponent(key));
    try {
      const response = await this.request(ctx, target, { headers: this.headers(ctx) });
      return this.toRecord(response.body, settings);
    } catch (error) {
      if (error instanceof AdapterError && error.normalized.kind === 'not_found') return null;
      throw error;
    }
  }

  async upsertRecord(
    ctx: AdapterContext,
    entity: string,
    record: AdapterRecord,
    idempotencyKey: string,
  ): Promise<UpsertResult> {
    if (!this.capabilities.supportsWrite) throw new UnsupportedOperationError('upsertRecord');
    const settings = this.settings(ctx);
    const template = settings.writePathTemplate.includes('{id}')
      ? settings.writePathTemplate
      : `${settings.writePathTemplate.replace(/\/$/, '')}/{id}`;
    const url = this.buildUrl(ctx, template, entity, { idempotency_key: idempotencyKey });

    const response = await this.request(ctx, url, {
      method: 'PUT',
      headers: this.headers(ctx, {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      }),
      body: JSON.stringify({ ...record.payload, [settings.keyPath]: record.key }),
    });

    const explicitKey = this.readPath(response.body, settings.keyPath);
    const confirmed = typeof explicitKey === 'string' && explicitKey.length > 0;
    const rawVersion = settings.versionPath
      ? this.readPath(response.body, settings.versionPath)
      : undefined;

    return {
      recordKey: confirmed ? explicitKey : record.key,
      version:
        typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : null,
      confirmed,
      detail: confirmed
        ? `Destination returned HTTP ${response.status} and confirmed record key "${explicitKey}".`
        : `Destination returned HTTP ${response.status} but did not confirm the record key, so this write is reported as unconfirmed.`,
    };
  }

  normalizeError(error: unknown): NormalizedAdapterError {
    if (error instanceof AdapterError) return error.normalized;
    if (error instanceof SsrfBlockedError) {
      return {
        kind: 'network',
        code: error.code,
        message: `Blocked by the SSRF guard: ${error.message}`,
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      };
    }
    if (error instanceof UnsupportedOperationError) {
      return {
        kind: 'unsupported',
        code: error.code,
        message: error.message,
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      };
    }
    const name = (error as { name?: string })?.name ?? 'Error';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return {
        kind: 'timeout',
        code: 'timeout',
        message: 'The request timed out before the destination answered.',
        retryable: true,
        status: null,
        retryAfterSeconds: null,
      };
    }
    return {
      kind: 'unknown',
      code: 'unknown_error',
      message: error instanceof Error ? error.message : 'Unknown connector error.',
      retryable: false,
      status: null,
      retryAfterSeconds: null,
    };
  }

  async getRateLimitState(ctx: AdapterContext): Promise<RateLimitState> {
    const settings = this.settings(ctx);
    return {
      limit: settings.requestsPerMinute,
      remaining: null,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      usedInWindow: 0,
      windowLimit: settings.requestsPerMinute,
    };
  }

  async knownFields(ctx: AdapterContext, entity: string): Promise<string[]> {
    void ctx;
    return this.options.knownFields?.[entity] ?? [];
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private parsePage(body: unknown, settings: RestSettingsInput): AdapterPage {
    const container = this.readPath(body, settings.itemsPath);

    let items: unknown = container;
    if (!Array.isArray(items) && container && typeof container === 'object') {
      items = this.readPath(container, 'results') ?? this.readPath(container, 'items');
    }

    if (!Array.isArray(items)) {
      throw new AdapterError({
        kind: 'invalid_response',
        code: 'unrecognised_envelope',
        message: `Could not find a record array at "${settings.itemsPath}". Check the items path.`,
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }

    const records: AdapterRecord[] = [];
    for (const item of items) {
      const record = this.toRecord(item, settings);
      if (record) records.push(record);
    }

    let nextCursor: string | null = null;
    if (settings.cursorPath) {
      const cursor = this.readPath(body, settings.cursorPath);
      if (typeof cursor === 'string' && cursor.length > 0) nextCursor = cursor;
      else if (typeof cursor === 'number') nextCursor = String(cursor);
    }

    return { records, nextCursor, unknownFields: [] };
  }

  private toRecord(value: unknown, settings: RestSettingsInput): AdapterRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    const rawKey = this.readPath(payload, settings.keyPath);
    if (typeof rawKey !== 'string' && typeof rawKey !== 'number') return null;
    const key = String(rawKey);

    const rawVersion = settings.versionPath ? this.readPath(payload, settings.versionPath) : null;
    return {
      key,
      payload,
      version:
        typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : null,
      updatedAt:
        typeof rawVersion === 'string' && !Number.isNaN(Date.parse(rawVersion))
          ? new Date(rawVersion).toISOString()
          : null,
    };
  }

  /** Dotted path reader with optional `[]` array indexes. Never evaluates code. */
  private readPath(value: unknown, path: string): unknown {
    if (!path) return undefined;
    const segments = path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter((segment) => segment.length > 0);
    let current: unknown = value;
    for (const segment of segments) {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current)) {
        const index = Number(segment);
        current = Number.isInteger(index) ? current[index] : undefined;
      } else if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }
    return current;
  }
}

/** Factory used by the container; kept separate so tests can build one directly. */
export function createRestAdapter(options: RestAdapterOptions = {}): RestConnectorAdapter {
  return new RestConnectorAdapter(options);
}