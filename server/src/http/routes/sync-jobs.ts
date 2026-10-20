import { Router } from 'express';
import { z } from 'zod';

import {
  createSyncJobSchema,
  idParamSchema,
  jobListQuerySchema,
  syncMappingInputSchema,
  updateSyncJobSchema,
  FIELD_TYPES,
  TRANSFORM_TYPES,
} from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const jobParams = z.object({
  organizationId: idParamSchema.shape.id,
  jobId: idParamSchema.shape.id,
});

const jobIdParams = z.object({
  jobId: idParamSchema.shape.id,
});

const mappingsBody = z.object({
  mappings: z.array(syncMappingInputSchema).max(200),
});

const previewBody = z.object({
  filename: z.string().trim().min(1).max(200),
  csv: z.string().min(1, 'The CSV file is empty').max(2 * 1024 * 1024, 'The file is larger than 2 MB'),
  mapping: z.record(z.string()).default({}),
});

export function syncJobRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: jobListQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.syncJobs.list(
          req.organization!.id,
          req.query as never,
        ),
      );
    }),
  );

  router.post(
    '/',
    requirePermission('job.manage'),
    validate({ body: createSyncJobSchema }),
    asyncHandler(async (req, res) => {
      const job = await services.syncJobs.create({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        ...req.body,
      });
      res.status(201).json({ job });
    }),
  );

  router.get(
    '/:jobId',
    validate({ params: jobIdParams }),
    asyncHandler(async (req, res) => {
      const job = await services.syncJobs.requireOwned(
        req.organization!.id,
        req.params.jobId as string,
      );
      res.json(await services.syncJobs.toListItem(job, ''));
    }),
  );

  router.patch(
    '/:jobId',
    requirePermission('job.manage'),
    validate({ params: jobIdParams, body: updateSyncJobSchema }),
    asyncHandler(async (req, res) => {
      const job = await services.syncJobs.update({
        organizationId: req.organization!.id,
        jobId: req.params.jobId as string,
        actorUserId: req.principal!.user.id,
        ...req.body,
      });
      res.json({ job: await services.syncJobs.toListItem(job, '') });
    }),
  );

  router.get(
    '/:jobId/runs',
    validate({ params: jobIdParams, query: jobListQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.syncJobs.listRuns(
          req.organization!.id,
          req.params.jobId as string,
          req.query as never,
        ),
      );
    }),
  );

  router.delete(
    '/:jobId',
    requirePermission('job.manage'),
    validate({ params: jobIdParams }),
    asyncHandler(async (req, res) => {
      await services.syncJobs.delete(
        req.organization!.id,
        req.params.jobId as string,
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  router.get(
    '/:jobId/mappings',
    validate({ params: jobParams }),
    asyncHandler(async (req, res) => {
      const jobId = req.params.jobId as string;
      await services.syncJobs.requireOwned(req.organization!.id, jobId);
      res.json({ mappings: await services.syncJobs.mappingsFor(req.organization!.id, jobId) });
    }),
  );

  router.post(
    '/:jobId/mappings',
    requirePermission('mapping.manage'),
    validate({ params: jobParams, body: mappingsBody }),
    asyncHandler(async (req, res) => {
      const jobId = req.params.jobId as string;
      await services.syncJobs.requireOwned(req.organization!.id, jobId);
      const result = await services.syncJobs.replaceMappings({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        jobId: req.params.jobId as string,
        mappings: req.body.mappings,
      });
      res.json({ result });
    }),
  );

  router.get(
    '/:jobId/mappings/preview',
    requirePermission('mapping.view'),
    validate({ params: jobParams, body: previewBody }),
    asyncHandler(async (req, res) => {
      const jobId = req.params.jobId as string;
      await services.syncJobs.requireOwned(req.organization!.id, jobId);
      const mappings = await services.syncJobs.mappingsFor(req.organization!.id, jobId);

      const preview = services.syncJobs.previewTransforms({
        mappings: mappings.map((mapping) => ({
          sourcePath: mapping.sourcePath,
          destinationPath: mapping.destinationPath,
          sourceType: mapping.sourceType as (typeof FIELD_TYPES)[number],
          destinationType: mapping.destinationType as (typeof FIELD_TYPES)[number],
          transformType: mapping.transformType as (typeof TRANSFORM_TYPES)[number],
          transformConfig: mapping.transformConfig,
          required: mapping.required,
          defaultValue: mapping.defaultValue ?? null,
          sortOrder: mapping.sortOrder,
        })),
        fixture: (req.body as { fixture: Array<Record<string, unknown>> }).fixture,
      });
      res.json(preview);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                        */
/* -------------------------------------------------------------------------- */

export function toMappingView(row: {
  id: string;
  syncJobId: string;
  sourcePath: string;
  destinationPath: string;
  sourceType: string;
  destinationType: string;
  transformType: string;
  transformConfig: Record<string, unknown>;
  required: boolean;
  defaultValue: string | null;
  sortOrder: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    sourcePath: row.sourcePath,
    destinationPath: row.destinationPath,
    sourceType: row.sourceType,
    destinationType: row.destinationType,
    transformType: row.transformType,
    transformConfig: row.transformConfig,
    required: row.required,
    defaultValue: row.defaultValue,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStepView(row: {
  id: string;
  organizationId: string;
  syncRunId: string;
  stepName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  counts: Record<string, number>;
  errorCode: string | null;
  safeMessage: string | null;
  sortOrder: number;
}) {
  return {
    id: row.id,
    stepName: row.stepName,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    counts: row.counts,
    errorCode: row.errorCode,
    safeMessage: row.safeMessage,
    sortOrder: row.sortOrder,
  };
}