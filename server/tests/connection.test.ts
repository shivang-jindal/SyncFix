import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, seedTenant } from './harness.js';

describe('Connection Service', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    tenant = await seedTenant(ctx, { email: 'test@example.com', organizationName: 'Test Org' });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('should create a connection', async () => {
    const connection = await ctx.services.connections.create({
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      provider: 'rest',
      name: 'Test REST API',
      environment: 'production',
      settings: { baseUrl: 'https://api.example.com', readPath: '/contacts', writePath: '/contacts', keyPath: 'id' },
      credentialKeys: ['api_key'],
      credentials: { api_key: 'test-key-123' },
    });
    expect(connection).toBeDefined();
    expect(connection.id).toBeDefined();
    expect(connection.name).toBe('Test REST API');
  });

  it('should list connections', async () => {
    const result = await ctx.services.connections.list(tenant.organization.id, {
      page: 1,
      pageSize: 10,
    });
    expect(result).toBeDefined();
    expect(result.items).toBeInstanceOf(Array);
  });
});