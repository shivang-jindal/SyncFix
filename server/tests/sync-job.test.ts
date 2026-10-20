import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, seedTenant } from './harness.js';

describe('Sync Job Service', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let sourceConnectionId: string;
  let destinationConnectionId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    tenant = await seedTenant(ctx, { email: 'test@example.com', organizationName: 'Test Org' });

    // Create source connection
    const sourceConn = await ctx.services.connections.create({
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      provider: 'rest',
      name: 'Source REST API',
      environment: 'production',
      settings: { baseUrl: 'https://api.source.com', readPath: '/contacts', writePath: '/contacts', keyPath: 'id' },
      credentialKeys: ['api_key'],
      credentials: { api_key: 'source-key-123' },
    });
    sourceConnectionId = sourceConn.id;

    // Create destination connection
    const destConn = await ctx.services.connections.create({
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      provider: 'rest',
      name: 'Destination REST API',
      environment: 'production',
      settings: { baseUrl: 'https://api.dest.com', readPath: '/contacts', writePath: '/contacts', keyPath: 'id' },
      credentialKeys: ['api_key'],
      credentials: { api_key: 'dest-key-123' },
    });
    destinationConnectionId = destConn.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('should create a sync job', async () => {
    const job = await ctx.services.syncJobs.create({
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      name: 'Test Sync Job',
      sourceConnectionId,
      destinationConnectionId,
      sourceEntity: 'contacts',
      destinationEntity: 'contacts',
      schedule: { cron: '0 * * * *', timezone: 'UTC' },
      conflictPolicy: 'source_wins',
      mappings: [],
    });
    expect(job).toBeDefined();
    expect(job.id).toBeDefined();
    expect(job.name).toBe('Test Sync Job');
  });

  it('should list sync jobs', async () => {
    const result = await ctx.services.syncJobs.list(tenant.organization.id, {
      page: 1,
      pageSize: 10,
    });
    expect(result).toBeDefined();
    expect(result.items).toBeInstanceOf(Array);
  });
});