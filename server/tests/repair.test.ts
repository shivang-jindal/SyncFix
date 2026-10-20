import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, seedTenant } from './harness.js';

describe('Repair Service', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedTenant(ctx, { email: 'test@example.com', organizationName: 'Test Org' });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('should have repair service available', () => {
    expect(ctx.services.repairs).toBeDefined();
  });
});