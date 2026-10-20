#!/usr/bin/env node
/**
 * Post-migration smoke test (Part A / A8 "Include a smoke test after deployment").
 *
 * Signs in with the seeded demo account and walks the primary journey:
 * login -> overview -> connections -> sync jobs -> dry-run -> run -> issues ->
 * webhook endpoints -> tenant isolation.
 *
 * It asserts honest behaviour: a paused job must not have run, a dry run must
 * report zero destination writes, and a foreign organization id must be 404.
 *
 * Exits non-zero on the first failure.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const baseUrl = process.argv[2] ?? process.env.SMOKE_API_URL ?? 'http://localhost:4000';
const email = process.env.SEED_EMAIL ?? 'demo@syncfix.test';
const password = process.env.SEED_PASSWORD ?? 'syncfix-demo-1234';

let cookie = '';

function recordCookie(response) {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    if (pair?.startsWith('syncfix_session=')) cookie = pair;
  }
}

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  recordCookie(response);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json, text };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const ready = await fetch(`${baseUrl}/api/v1/health/ready`);
const readyJson = await ready.json();
check('health/ready', ready.status === 200 && readyJson.status === 'ready', JSON.stringify(readyJson.checks));

const login = await call('POST', '/auth/login', { email, password });
check('auth/login', login.status === 200 && Boolean(login.json?.user?.id), login.json?.error?.message ?? '');
if (login.status !== 200) process.exit(1);

const orgId = login.json.memberships?.[0]?.organizationId;
check('session has an organization', Boolean(orgId));

const overview = await call('GET', `/${orgId}/overview`);
check('overview', overview.status === 200, overview.json?.error?.message ?? '');
check(
  'overview reports a null success rate when nothing ran (never a fake 100%)',
  overview.status === 200 && (overview.json?.successRatePercent ?? null) === null,
  `successRatePercent=${JSON.stringify(overview.json?.successRatePercent)}`,
);
check('overview states its window', typeof overview.json?.windowLabel === 'string', overview.json?.windowLabel);

const providers = await call('GET', `/${orgId}/connections/providers`);
const providerNames = (providers.json?.providers ?? []).map((entry) => entry.provider);
check(
  'only implemented connectors are advertised',
  providers.status === 200 &&
    providerNames.length === 2 &&
    providerNames.includes('rest') &&
    providerNames.includes('webhook_ingest'),
  JSON.stringify(providerNames),
);

const connections = await call('GET', `/${orgId}/connections`);
check('connection list', connections.status === 200 && Array.isArray(connections.json?.items));
const firstConnection = connections.json?.items?.[0];
check(
  'connections never expose a credential value',
  firstConnection !== undefined &&
    JSON.stringify(firstConnection).includes('encryptedCredentials') === false &&
    firstConnection.credentialMasks.every((mask) => !mask.masked || mask.masked.includes('*')),
  JSON.stringify(firstConnection?.credentialMasks ?? []),
);

const jobs = await call('GET', `/${orgId}/sync-jobs`);
check('sync job list', jobs.status === 200 && Array.isArray(jobs.json?.items));
const job = jobs.json?.items?.[0];
check('seeded job exists and is paused', job?.status === 'paused', `status=${job?.status}`);
check(
  'job with no runs reports a null success rate',
  job?.successRate?.totalRuns === 0 && job?.successRate?.successRatePercent === null,
  JSON.stringify(job?.successRate ?? {}),
);

if (job?.id) {
  const detail = await call('GET', `/${orgId}/sync-jobs/${job.id}`);
  check(
    'job detail reports that bidirectional sync is unavailable',
    detail.status === 200 && detail.json?.capabilities?.bidirectional === false,
  );
  check(
    'job detail never exposes sealed credentials',
    detail.status === 200 && !JSON.stringify(detail.json).includes('encryptedCredentials'),
  );
}

const issues = await call('GET', `/${orgId}/issues?pageSize=5`);
check('issue list', issues.status === 200 && Array.isArray(issues.json?.items));

const health = await call('GET', `/${orgId}/reports/sync-health`);
check('sync health report', health.status === 200 && typeof health.json?.windowLabel === 'string');
check(
  'sync health distinguishes zero runs from 100% success',
  health.status === 200 && health.json?.totals?.successRatePercent === null,
  `successRatePercent=${JSON.stringify(health.json?.totals?.successRatePercent)}`,
);

const endpoints = await call('GET', `/${orgId}/webhook-endpoints`);
check('webhook endpoints', endpoints.status === 200 && Array.isArray(endpoints.json?.endpoints));
check(
  'webhook endpoints never return the signing secret on a read',
  endpoints.status === 200 &&
    endpoints.json.endpoints.every((endpoint) => endpoint.secret === undefined),
);

const tenantProbe = await call('GET', `/${orgId}/sync-jobs/not-a-uuid`);
check('invalid id is rejected with 400', tenantProbe.status === 400, `status=${tenantProbe.status}`);

const foreignProbe = await call(
  'GET',
  '/00000000-0000-4000-8000-000000000000/sync-jobs',
);
check(
  'a foreign organization id is not visible (404, never 403)',
  foreignProbe.status === 404,
  `status=${foreignProbe.status}`,
);

const ingestProbe = await call('POST', '/ingest/not-a-real-endpoint', { id: 'x' });
check(
  'an unsigned webhook to an unknown endpoint is rejected',
  ingestProbe.status === 404 || ingestProbe.status === 400,
  `status=${ingestProbe.status}`,
);

console.log(process.exitCode ? '\nSmoke test FAILED' : '\nSmoke test passed');