/**
 * Test harness.
 *
 * Every integration test runs against a real PostgreSQL engine (PGlite) with
 * the production migrations applied, so schema, constraints, transactions and
 * tenant scoping behave exactly as they will in production.
 */

import { createServices, type Services } from '../src/container.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDatabase, runMigrations, type DatabaseHandle } from '../src/db/client.js';
import { createLogger } from '../src/logger.js';

export interface TestContext {
  handle: DatabaseHandle;
  services: Services;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    EMAIL_PROVIDER: 'disabled',
    WORKER_ENABLED: 'false',
    SESSION_COOKIE_NAME: 'syncfix_test',
    ENCRYPTION_KEY: 'a3d4d12f3fed34c1df5a35a0d3cca82fc9eade1708ff6e2208b1e6a43306c036',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const handle = await createDatabase({ memory: true });
  await runMigrations(handle);

  const services = createServices({
    db: handle.db,
    config,
    logger: createLogger({ level: 'silent', isProduction: false, name: 'test' }),
  });

  return {
    handle,
    services,
    config,
    close: async () => {
      await handle.close();
    },
  };
}

export async function seedTenant(
  context: TestContext,
  input: { email: string; organizationName: string; baseCurrency?: string },
) {
  const { user } = await context.services.auth.register({
    email: input.email,
    password: 'a-very-long-test-password',
    displayName: 'Test Owner',
  });
  const organization = await context.services.organizations.create({
    name: input.organizationName,
    countryCode: 'US',
    timezone: 'UTC',
    baseCurrency: input.baseCurrency ?? 'USD',
    ownerId: user.id,
  });
  await context.services.email.seedTemplates(organization.id);
  return { user, organization };
}