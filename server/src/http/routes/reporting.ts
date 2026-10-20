import { Router } from 'express';

import { overviewQuerySchema, syncHealthQuerySchema } from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';
import { resolveWindow } from '../../services/report.service.js';

export function reportRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/overview',
    requirePermission('report.view'),
    validate({ query: overviewQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as { from?: string; to?: string };
      const window = resolveWindow(query.from, query.to);
      res.json(await services.reports.overview(req.organization!.id, window));
    }),
  );

  router.get(
    '/sync-health',
    requirePermission('report.view'),
    validate({ query: syncHealthQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as { from?: string; to?: string };
      const window = resolveWindow(query.from, query.to);
      res.json(await services.reports.syncHealth(req.organization!.id, window));
    }),
  );

  router.get(
    '/recent-runs',
    requirePermission('job.view'),
    asyncHandler(async (req, res) => {
      res.json({ runs: await services.reports.recentRuns(req.organization!.id, 15) });
    }),
  );

  router.get(
    '/queue',
    requirePermission('audit.view'),
    asyncHandler(async (req, res) => {
      // The dead-letter state is visible rather than hidden.
      const [stats, failed] = await Promise.all([
        services.jobs.stats(req.organization!.id),
        services.jobs.listFailedForOrganization(req.organization!.id, 50),
      ]);
      res.json({
        stats,
        // Exhausted jobs stay visible so an operator can retry them by hand.
        deadLetter: failed.map((job) => ({
          id: job.id,
          jobType: job.jobType,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          lastErrorCode: job.lastErrorCode,
          lastErrorMessage: job.lastErrorMessage,
          runAfter: job.runAfter.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  return router;
}