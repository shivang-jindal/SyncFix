import { Router } from 'express';
import { z } from 'zod';

import {
  DESTRUCTIVE_REPAIR_PHRASE,
  idParamSchema,
  issueListQuerySchema,
  RepairContext,
  resolveIssueSchema,
  retryIssueSchema,
  skipIssueSchema,
} from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const issueParams = z.object({
  organizationId: idParamSchema.shape.id,
  issueId: idParamSchema.shape.id,
});

export function issueRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: issueListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as never;
      res.json(await services.issues.list(req.organization!.id, query));
    }),
  );

  router.get(
    '/:issueId',
    validate({ params: issueParams }),
    asyncHandler(async (req, res) => {
      res.json({
        issue: await services.issues.detail(req.organization!.id, req.params.issueId as string),
      });
    }),
  );

  router.post(
    '/:issueId/retry',
    requirePermission('issue.repair'),
    validate({ params: issueParams, body: retryIssueSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { replayFromSource: boolean; note?: string };
      const result = await services.repairs.retry({
        ctx: repairContext(req),
        issueId: req.params.issueId as string,
        replayFromSource: body.replayFromSource,
        ...(body.note ? { note: body.note } : {}),
      });
      res.status(result.status === 'succeeded' ? 200 : 200).json(result);
    }),
  );

  router.post(
    '/:issueId/skip',
    requirePermission('issue.repair'),
    validate({ params: issueParams, body: skipIssueSchema.extend({ confirmation: z.string().optional() }) }),
    asyncHandler(async (req, res) => {
      const body = req.body as { reason: string; confirmation?: string };
      const result = await services.repairs.skip({
        ctx: repairContext(req),
        issueId: req.params.issueId as string,
        reason: body.reason,
        ...(body.confirmation ? { confirmation: body.confirmation } : {}),
      });
      res.json(result);
    }),
  );

  router.post(
    '/:issueId/resolve',
    requirePermission('issue.repair'),
    validate({ params: issueParams, body: resolveIssueSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { reason: string; confirmation?: string };
      const result = await services.repairs.resolve({
        ctx: repairContext(req),
        issueId: req.params.issueId as string,
        reason: body.reason,
        ...(body.confirmation ? { confirmation: body.confirmation } : {}),
      });
      res.json(result);
    }),
  );

  return router;
}

function repairContext(req: {
  organization?: { id: string };
  principal?: { user: { id: string } };
  permissions?: string[];
  requestId: string;
  clientIp: string | null;
}): RepairContext {
  return {
    organizationId: req.organization!.id,
    actorUserId: req.principal!.user.id,
    mayRepairDestructively: (req.permissions ?? []).includes('issue.repair.destructive'),
    requestId: req.requestId,
    ipAddress: req.clientIp,
  };
}

export { DESTRUCTIVE_REPAIR_PHRASE };