import { Router } from 'express';
import { z } from 'zod';

import {
  connectionListQuerySchema,
  createConnectionSchema,
  idParamSchema,
  rotateConnectionSchema,
  updateConnectionSchema,
} from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const enableBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

const params = z.object({
  organizationId: idParamSchema.shape.id,
  connectionId: idParamSchema.shape.id,
});

export function connectionRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/providers',
    asyncHandler(async (_req, res) => {
      // The catalogue is built from the adapters that are actually registered
      // and tested. Nothing is advertised that is not implemented.
      res.json({ providers: services.connections.catalogue() });
    }),
  );

  router.get(
    '/',
    validate({ query: connectionListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        q?: string;
        provider?: string;
        status?: string;
        sort: string;
        order: 'asc' | 'desc';
      };
      const { items, total } = await services.connections.list(req.organization!.id, query);
      res.json({
        items: items.map((connection) => services.connections.toListItem(connection)),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      });
    }),
  );

  router.post(
    '/',
    requirePermission('connection.manage'),
    validate({ body: createConnectionSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        provider: string;
        name: string;
        environment: string;
        credentials: Record<string, string | undefined>;
        scopes: string[];
        settings: Record<string, unknown>;
      };
      const connection = await services.connections.create({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        provider: body.provider,
        name: body.name,
        environment: body.environment,
        credentials: body.credentials,
        scopes: body.scopes ?? [],
        settings: body.settings ?? {},
        requestId: req.requestId,
        ipAddress: req.clientIp,
      });
      // 201 + `connection` only. No credential value is ever returned.
      res.status(201).json({ connection: services.connections.toListItem(connection) });
    }),
  );

  router.get(
    '/:connectionId',
    validate({ params }),
    asyncHandler(async (req, res) => {
      const connection = await services.connections.get(
        req.organization!.id,
        req.params.connectionId as string,
      );
      const [testRuns, rateLimit] = await Promise.all([
        services.connections.recentTestRuns(connection.id, 10),
        services.connections.rateLimitState(connection),
      ]);
      res.json({
        connection: services.connections.toListItem(connection),
        testRuns: testRuns.map((run) => ({
          id: run.id,
          connectionId: run.connectionId,
          status: run.status,
          testedAt: (run.testedAt as unknown as Date) instanceof Date ? (run.testedAt as unknown as Date).toISOString() : String(run.testedAt),
          latencyMs: run.latencyMs,
          errorCode: run.errorCode,
          safeMessage: run.safeMessage,
        })),
        rateLimit,
      });
    }),
  );

  router.patch(
    '/:connectionId',
    requirePermission('connection.manage'),
    validate({ params, body: updateConnectionSchema }),
    asyncHandler(async (req, res) => {
      const connection = await services.connections.update({
        organizationId: req.organization!.id,
        connectionId: req.params.connectionId as string,
        actorUserId: req.principal!.user.id,
        patch: req.body as never,
        requestId: req.requestId,
      });
      res.json({ connection: services.connections.toListItem(connection) });
    }),
  );

  router.post(
    '/:connectionId/rotate',
    requirePermission('connection.rotate'),
    validate({ params, body: rotateConnectionSchema }),
    asyncHandler(async (req, res) => {
      const connection = await services.connections.rotate({
        organizationId: req.organization!.id,
        connectionId: req.params.connectionId as string,
        actorUserId: req.principal!.user.id,
        credentials: (req.body as { credentials: Record<string, string | undefined> }).credentials,
        requestId: req.requestId,
      });
      res.json({ connection: services.connections.toListItem(connection) });
    }),
  );

  router.post(
    '/:connectionId/enable',
    requirePermission('connection.manage'),
    validate({ params, body: enableBody }),
    asyncHandler(async (req, res) => {
      const connection = await services.connections.disable({
        organizationId: req.organization!.id,
        connectionId: req.params.connectionId as string,
        actorUserId: req.principal!.user.id,
        enabled: (req.body as { enabled: boolean }).enabled,
        requestId: req.requestId,
      });
      res.json({ connection: services.connections.toListItem(connection) });
    }),
  );

  router.post(
    '/:connectionId/test',
    requirePermission('connection.manage'),
    validate({ params }),
    asyncHandler(async (req, res) => {
      const result = await services.connections.test({
        organizationId: req.organization!.id,
        connectionId: req.params.connectionId as string,
        actorUserId: req.principal!.user.id,
      });
      res.status(result.result.ok ? 200 : 200).json({
        connection: services.connections.toListItem(result.connection),
        testRun: {
          id: result.testRun.id,
          connectionId: result.testRun.connectionId,
          status: result.testRun.status,
          testedAt: (result.testRun.testedAt as unknown as Date) instanceof Date ? (result.testRun.testedAt as unknown as Date).toISOString() : String(result.testRun.testedAt),
          latencyMs: result.testRun.latencyMs,
          errorCode: result.testRun.errorCode,
          safeMessage: result.testRun.safeMessage,
        },
        result: {
          ok: result.result.ok,
          latencyMs: result.result.latencyMs,
          errorCode: result.result.errorCode,
          message: result.result.message,
          entities: result.result.entities ?? [],
        },
      });
    }),
  );

  return router;
}