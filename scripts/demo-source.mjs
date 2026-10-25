#!/usr/bin/env node
/**
 * Local demo fixture source (development only).
 *
 * A tiny, dependency-free HTTP server that answers the shape the generic REST
 * connector expects. It exists so the seeded demo connections point at
 * something real that SyncFix genuinely talks to, without depending on any
 * third-party service or account.
 *
 * It deliberately emulates a real integration, including its failure modes:
 *
 *   GET  /contacts?limit&cursor   paginated list with an opaque cursor
 *   GET  /contacts/{id}           single record
 *   PUT  /customers/{id}          idempotent upsert, echoes the record key
 *   PUT  /customers               idempotent upsert by body id
 *   GET  /flaky                   503 on every call (rate-limit / outage demo)
 *   GET  /slow                    never answers (timeout demo)
 *   POST /reset                   clears all written records
 *   GET  /_stats                  how many records were written (honest count)
 *
 * Nothing here is production code. It is a test double that a human runs.
 *
 * Usage: node scripts/demo-source.mjs [port]
 */

import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';

const port = Number(process.argv[2] ?? process.env.DEMO_SOURCE_PORT ?? 8080);

/** Source contacts. One of them is deliberately missing an email. */
const CONTACTS = [
  {
    id: 'c-1001',
    fullName: '  Ada Lovelace  ',
    email: 'ADA@EXAMPLE.COM',
    lifetimeValue: '1284.50',
    status: 'active',
    updatedAt: '2026-01-15T09:12:00.000Z',
    internalNote: 'do not sync - contains a note only the source should have',
  },
  {
    id: 'c-1002',
    fullName: 'Grace Hopper',
    email: 'grace@example.com',
    lifetimeValue: '990',
    status: 'active',
    updatedAt: '2026-02-02T17:45:00.000Z',
  },
  {
    id: 'c-1003',
    fullName: 'Alan Turing',
    email: 'alan@example.com',
    lifetimeValue: 'not-a-number',
    status: 'active',
    updatedAt: '2026-02-11T08:00:00.000Z',
  },
  {
    id: 'c-1004',
    fullName: 'Katherine Johnson',
    email: 'katherine@example.com',
    lifetimeValue: '2500',
    status: 'active',
    updatedAt: '2026-03-05T11:30:00.000Z',
  },
  {
    id: 'c-1005',
    fullName: 'Archived Person',
    email: 'archived@example.com',
    lifetimeValue: '10',
    status: 'archived',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Destination store. Idempotent: the same id always overwrites the same row. */
const written = new Map();
const idempotencyHits = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const segments = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/_stats') {
    json(res, 200, {
      writtenRecords: written.size,
      idempotencyReplays: [...idempotencyHits.values()].filter((count) => count > 1).length,
      note: 'A real count of what this fixture server actually received.',
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/reset') {
    const count = written.size;
    written.clear();
    idempotencyHits.clear();
    json(res, 200, { cleared: count });
    return;
  }

  if (method === 'GET' && url.pathname === '/flaky') {
    json(res, 503, { error: 'The demo fixture is intentionally unavailable.' });
    return;
  }

  if (method === 'GET' && url.pathname === '/slow') {
    // Never answers: exercises the connector timeout path.
    await sleep(120_000);
    return;
  }

  // Auth: the seeded connections send `Authorization: Bearer demo-*-token`.
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    json(res, 401, { error: 'Missing or malformed bearer credential.' });
    return;
  }

  // The connector probes the configured path templates with the reserved
  // entity name "default". Serving it keeps "Test connection" meaningful here.
  if (segments[0] === 'default' && method === 'GET') {
    json(res, 200, { data: CONTACTS.slice(0, 5), nextCursor: null });
    return;
  }

  if (segments[0] === 'contacts' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 100);
    const offset = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const page = CONTACTS.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    json(res, 200, {
      data: page,
      nextCursor: nextOffset < CONTACTS.length ? String(nextOffset) : null,
    });
    return;
  }

  if (segments[0] === 'contacts' && segments[1] && method === 'GET') {
    const record = CONTACTS.find((entry) => entry.id === segments[1]);
    if (!record) {
      json(res, 404, { error: 'Not found' });
      return;
    }
    json(res, 200, record);
    return;
  }

  if (segments[0] === 'customers' && (method === 'PUT' || method === 'POST')) {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      json(res, 400, { error: 'Body is not valid JSON.' });
      return;
    }

    const key = segments[1] ?? body.externalId ?? body.id;
    if (!key) {
      // Mirrors a real API that cannot identify the resource.
      json(res, 400, { error: 'No record key supplied.' });
      return;
    }

    const idempotencyKey = String(req.headers['idempotency-key'] ?? url.searchParams.get('idempotency_key') ?? '');
    if (idempotencyKey) {
      idempotencyHits.set(idempotencyKey, (idempotencyHits.get(idempotencyKey) ?? 0) + 1);
    }

    written.set(key, {
      ...(written.get(key) ?? {}),
      ...body,
      id: key,
      updatedAt: new Date().toISOString(),
    });

    // A real idempotent upsert: the key comes back so SyncFix can confirm it.
    json(res, 200, written.get(key), { 'idempotency-key': idempotencyKey });
    return;
  }

  json(res, 404, { error: `No demo route for ${method} ${url.pathname}` });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    [
      `SyncFix demo fixture source listening on http://127.0.0.1:${port}`,
      '',
      'Routes:',
      '  GET  /contacts?limit=&cursor=   paginated source records',
      '  GET  /contacts/:id',
      '  GET  /default                   probe used by Test connection',
      '  PUT  /customers/:id              idempotent upsert (echoes the key)',
      '  GET  /flaky                      always 503 (outage demo)',
      '  GET  /slow                       never answers (timeout demo)',
      '  GET  /_stats                     honest counters',
      '  POST /reset                      clear written records',
      '',
      'Any request without a bearer credential gets 401.',
      'This is a development fixture. It is never used in production.',
      '',
    ].join('\n'),
  );
});