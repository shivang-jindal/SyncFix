import { Router } from 'express';
import { z } from 'zod';

import { idParamSchema, runListQuerySchema } from '@syncfix/shared';

import type { Services } from '../../container.js';
import { notFound } from '../../errors.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';
import { toStepView } from './sync-jobs.js';

const runParams = z.object({
  organizationId: idParamSchema.shape.id,
  runId: idParamSchema.shape.id,
});

export function runRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    requirePermission('job.view'),
    validate({ query: runListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        status: string;
        trigger: string;
        sort: string;
        order: 'asc' | 'desc';
      };
      res.json(await services.reports.runs(req.organization!.id, query));
    }),
  );

  router.get(
    '/:runId',
    requirePermission('job.view'),
    validate({ params: runParams }),
    asyncHandler(async (req, res) => {
      const detail = await services.reports.runDetail(
        req.organization!.id,
        req.params.runId as string,
      );
      if (!detail) throw notFound('Sync run');

      const notes: string[] = [];
      if (detail.run.dryRun) {
        notes.push(
          'This was a dry run: no destination write was attempted, no record was marked synced and the checkpoint did not advance. Created and updated counts are projections of what a real run would do.',
        );
      }
      if (detail.run.status === 'partial') {
        notes.push(
          'Partial success: some records were written and some failed. The failed records are retained as open issues.',
        );
      }
      if (detail.run.cursorEnd && detail.run.cursorStart !== detail.run.cursorEnd) {
        notes.push(
          'The checkpoint advanced. Resuming skips records already committed; a replay of an uncommitted page is made safe by the idempotency key.',
        );
      }

      res.json({
        run: {
          id: detail.run.id,
          syncJobId: detail.run.syncJobId,
          syncJobName: detail.jobName,
          trigger: detail.run.triggerType,
          status: detail.run.status,
          dryRun: detail.run.dryRun,
          startedAt: detail.run.startedAt.toISOString(),
          finishedAt: detail.run.finishedAt?.toISOString() ?? null,
          durationMs: detail.run.durationMs,
          fetchedCount: detail.run.fetchedCount,
          createdCount: detail.run.createdCount,
          updatedCount: detail.run.updatedCount,
          skippedCount: detail.run.skippedCount,
          failedCount: detail.run.failedCount,
          cursorStart: detail.run.cursorStart,
          cursorEnd: detail.run.cursorEnd,
          errorCode: detail.run.errorCode,
          safeMessage: detail.run.safeMessage,
          requestId: detail.run.requestId,
          steps: detail.steps.map(toStepView),
          errorCategories: detail.errorCategories,
          retryableFailureCount: detail.retryableFailureCount,
          notes,
        },
      });
    }),
  );

  return router;
}
