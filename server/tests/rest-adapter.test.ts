/**
 * Regression tests for the generic REST adapter's URL building.
 *
 * A record key must reach the path template. If `{id}` is rendered from the
 * entity name instead, every write collapses onto one destination object, and
 * the adapter still reports each write as confirmed. That is exactly the kind
 * of silent data loss this test exists to prevent.
 */

import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RestConnectorAdapter } from '../src/adapters/rest.js';
import type { AdapterContext } from '../src/adapters/types.js';
import { configureAllowedPorts, configureSsrfAllowList } from '../src/lib/safe-fetch.js';

const paths: string[] = [];
let server: Server;
let context: AdapterContext;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '/';
      paths.push(path);
      const pathname = new URL(path, 'http://127.0.0.1').pathname;
      const key = decodeURIComponent(pathname.split('/').pop() ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: key,
          updatedAt: '2026-01-01T00:00:00.000Z',
          echoedBody: body,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // The adapter is guarded by the SSRF allow-list and the port allow-list; a
  // test server on an ephemeral loopback port must be explicitly allowed.
  configureSsrfAllowList(['127.0.0.1']);
  configureAllowedPorts([address.port]);

  context = {
    organizationId: '00000000-0000-4000-8000-000000000001',
    connectionId: '00000000-0000-4000-8000-000000000002',
    connectionName: 'Test REST API',
    environment: 'test',
    settings: {
      baseUrl,
      readPathTemplate: '/{entity}',
      writePathTemplate: '/{entity}/{id}',
      keyPath: 'id',
      cursorPath: null,
      versionPath: 'updatedAt',
      authScheme: 'bearer',
      timeoutMs: 5_000,
      pageSizeLimit: 50,
      requestsPerMinute: 600,
    },
    credentials: { token: 'test-token' },
    consumeQuota: async () => {},
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('RestConnectorAdapter URLs', () => {
  it('puts each record key in its own write path', async () => {
    const adapter = new RestConnectorAdapter();
    paths.length = 0;

    const results = [];
    for (const key of ['c-1', 'c-2']) {
      results.push(
        await adapter.upsertRecord(
          context,
          'customers',
          { key, payload: { externalId: key }, version: null, updatedAt: null },
          `idem-${key}`,
        ),
      );
    }

    expect(paths.map((path) => path.split('?')[0])).toEqual([
      '/customers/c-1',
      '/customers/c-2',
    ]);
    expect(results.map((result) => result.recordKey)).toEqual(['c-1', 'c-2']);
    expect(results.every((result) => result.confirmed)).toBe(true);
  });

  it('reads a single record from its own path', async () => {
    const adapter = new RestConnectorAdapter();
    paths.length = 0;

    const record = await adapter.getRecord(context, 'contacts', 'c-42');

    expect(paths).toEqual(['/contacts/c-42']);
    expect(record?.key).toBe('c-42');
  });
});
