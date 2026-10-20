import { Router } from 'express';
import { z } from 'zod';

import {
  createWebhookEndpointSchema,
  idParamSchema,
  updateWebhookEndpointSchema,
} from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const endpointParams = z.object({
  organizationId: idParamSchema.shape.id,
  endpointId: idParamSchema.shape.id,
});

const eventsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  endpointId: idParamSchema.shape.id.optional(),
  status: z.string().trim().max(40).optional(),
});

export function webhookEndpointRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      // No `secret` field is ever present on a list or read response.
      res.json({ endpoints: await services.webhooks.list(req.organization!.id) });
    }),
  );

  router.post(
    '/',
    requirePermission('webhook.manage'),
    validate({ body: createWebhookEndpointSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        name: string;
        enabled: boolean;
        settings: Record<string, unknown>;
      };
      const created = await services.webhooks.create({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        name: body.name,
        enabled: body.enabled ?? true,
        settings: body.settings ?? {},
        requestId: req.requestId,
      });
      // `secret` appears exactly once, here, and never again except at rotation.
      res.status(201).json({
        ...created,
        warning:
          'Copy the signing secret now. SyncFix cannot show it again. You can rotate it at any time.',
      });
    }),
  );

  router.patch(
    '/:endpointId',
    requirePermission('webhook.manage'),
    validate({ params: endpointParams, body: updateWebhookEndpointSchema }),
    asyncHandler(async (req, res) => {
      const endpoint = await services.webhooks.update({
        organizationId: req.organization!.id,
        endpointId: req.params.endpointId as string,
        actorUserId: req.principal!.user.id,
        patch: req.body as never,
        requestId: req.requestId,
      });
      res.json({ endpoint });
    }),
  );

  router.post(
    '/:endpointId/rotate',
    requirePermission('webhook.manage'),
    validate({ params: endpointParams }),
    asyncHandler(async (req, res) => {
      const rotated = await services.webhooks.rotate({
        organizationId: req.organization!.id,
        endpointId: req.params.endpointId as string,
        actorUserId: req.principal!.user.id,
        requestId: req.requestId,
      });
      res.json({
        ...rotated,
        warning:
          'A new signing secret was issued. The previous secret stopped working immediately. Copy the new one now.',
      });
    }),
  );

  router.get(
    '/events',
    validate({ query: eventsQuery }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        endpointId?: string;
        status?: string;
      };
      const { items, total } = await services.webhooks.events(req.organization!.id, query);
      res.json({
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      });
    }),
  );

  return router;
}