/**
 * Development / demo seed (`npm run db:seed`).
 *
 * Seed data is only ever created by this explicit command (Part A / A4.5). A
 * production account always starts empty and this command refuses to run
 * against a production database.
 *
 * What is created is deliberately small and honest:
 *  - one organization with two REST connections pointing at the LOCAL demo
 *    fixture server (see scripts/demo-source.mjs) - NOT at any third party,
 *  - one paused sync job with real field mappings,
 *  - a webhook endpoint whose secret is printed to the console ONCE.
 *
 * No run, issue or metric is fabricated. Until the worker actually executes
 * the job, the dashboard reports "no runs yet".
 */

import { eq } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { createDatabase, runMigrations } from './client.js';
import { createServices } from '../container.js';
import { createLogger } from '../logger.js';

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@syncfix.test';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'syncfix-demo-1234';
/** The local demo fixture server started by `npm run demo:source`. */
const DEMO_BASE_URL = process.env.SEED_DEMO_BASE_URL ?? 'http://127.0.0.1:4321';

const REST_SETTINGS = {
  baseUrl: DEMO_BASE_URL,
  readPathTemplate: '/{entity}',
  writePathTemplate: '/{entity}/{id}',
  itemsPath: 'data',
  cursorPath: 'nextCursor',
  keyPath: 'id',
  versionPath: 'updatedAt',
  authScheme: 'bearer',
  authHeaderName: 'Authorization',
  authQueryParam: null,
  username: null,
  extraHeaders: {},
  timeoutMs: 5000,
  pageSizeLimit: 100,
  requestsPerMinute: 600,
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) {
    throw new Error('Refusing to seed a production database. Run the seed command against a development database.');
  }
  if (!config.encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY must be set to seed connections. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
  });
  await runMigrations(database);

  const logger = createLogger({ level: 'info', isProduction: false, name: 'seed' });
  const services = createServices({ db: database.db, config, logger });

  try {
    const { users } = await import('./schema.js');
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, DEMO_EMAIL))
      .limit(1);

    if (existing[0]) {
      console.log(`[db:seed] ${DEMO_EMAIL} already exists; nothing to do.`);
      return;
    }

    const { user } = await services.auth.register({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Demo Owner',
    });

    const organization = await services.organizations.create({
      name: 'Demo Workspace',
      countryCode: 'US',
      timezone: 'America/New_York',
      baseCurrency: 'USD',
      ownerId: user.id,
    });
    await services.email.seedTemplates(organization.id);
    await services.organizations.updateSettings(organization.id, user.id, {
      redactFields: ['tax_id', 'bank_account', 'notes'],
      issueNotificationEmails: [],
    });

    // --- Connections ------------------------------------------------------
    // Both point at the LOCAL demo fixture server. Nothing external is
    // contacted, so the seed never depends on a third-party service.
    const source = await services.connections.create({
      organizationId: organization.id,
      actorUserId: user.id,
      provider: 'rest',
      name: 'Local demo source (CRM)',
      environment: 'development',
      credentials: { token: 'demo-source-token' },
      scopes: ['read:contacts'],
      settings: REST_SETTINGS,
    });

    const destination = await services.connections.create({
      organizationId: organization.id,
      actorUserId: user.id,
      provider: 'rest',
      name: 'Local demo destination (ERP)',
      environment: 'development',
      credentials: { token: 'demo-destination-token' },
      scopes: ['write:customers'],
      settings: { ...REST_SETTINGS, baseUrl: process.env.SEED_DEMO_BASE_URL ?? DEMO_BASE_URL },
    });

    // --- Job --------------------------------------------------------------
    // Created PAUSED. Nothing runs until the operator explicitly enables it
    // (Part D / D10: "No sync job runs without an explicit enable action").
    const job = await services.syncJobs.create({
      organizationId: organization.id,
      actorUserId: user.id,
      name: 'CRM contacts -> ERP customers',
      sourceConnectionId: source.id,
      destinationConnectionId: destination.id,
      sourceEntity: 'contacts',
      destinationEntity: 'customers',
      conflictPolicy: 'source_wins',
      scheduleCron: null,
      timezone: 'America/New_York',
      batchSize: 50,
      retryPolicy: { mode: 'safe_only', maxAttempts: 3, backoffSeconds: 60 },
      filters: [{ field: 'status', operator: 'neq', value: 'archived' }],
      mappings: [
        {
          sourcePath: 'id',
          destinationPath: 'externalId',
          sourceType: 'string',
          destinationType: 'string',
          transformType: 'none',
          transformConfig: {},
          required: true,
          sortOrder: 0,
        },
        {
          sourcePath: 'fullName',
          destinationPath: 'name',
          sourceType: 'string',
          destinationType: 'string',
          transformType: 'trim',
          transformConfig: {},
          required: true,
          sortOrder: 1,
        },
        {
          sourcePath: 'email',
          destinationPath: 'email',
          sourceType: 'string',
          destinationType: 'string',
          transformType: 'lowercase',
          transformConfig: {},
          required: false,
          sortOrder: 2,
        },
        {
          sourcePath: 'lifetimeValue',
          destinationPath: 'amount',
          sourceType: 'number',
          destinationType: 'number',
          transformType: 'to_number',
          transformConfig: {},
          required: false,
          sortOrder: 3,
        },
        {
          sourcePath: 'updatedAt',
          destinationPath: 'externalUpdatedAt',
          sourceType: 'datetime',
          destinationType: 'datetime',
          transformType: 'to_iso_datetime',
          transformConfig: {},
          required: false,
          sortOrder: 4,
        },
      ],
    });

    // --- Webhook endpoint --------------------------------------------------
    const endpoint = await services.webhooks.create({
      organizationId: organization.id,
      actorUserId: user.id,
      name: 'Local demo webhook source',
      enabled: true,
      settings: {
        externalEventIdPath: 'id',
        signatureHeader: 'x-syncfix-signature',
        timestampHeader: 'x-syncfix-timestamp',
        maxPayloadBytes: 262_144,
      },
    });

    console.log('');
    console.log('[db:seed] demo workspace created.');
    console.log(`           email:        ${DEMO_EMAIL}`);
    console.log(`           password:     ${DEMO_PASSWORD}`);
    console.log(`           organization: ${organization.name} (${organization.slug})`);
    console.log(`           source conn:  ${source.name} -> ${DEMO_BASE_URL}`);
    console.log(`           dest conn:    ${destination.name}`);
    console.log(`           job:          ${job.name} (PAUSED - nothing runs until you enable it)`);
    console.log('');
    console.log('[db:seed] The demo REST connections point at a LOCAL fixture server.');
    console.log('           Start it with:  npm run demo:source');
    console.log('           Then test the connections from the Connections screen.');
    console.log('');
    console.log('[db:seed] Webhook endpoint (copy the secret now, it is shown once):');
    console.log(`           url:    ${endpoint.url}`);
    console.log(`           secret: ${endpoint.secret}`);
    console.log('');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error('[db:seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});