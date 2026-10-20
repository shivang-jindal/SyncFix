const content = `import { Router } from 'express';
import { z } from 'zod';

import {
  createSyncJobSchema,
  idParamSchema,
  jobListQuerySchema,
  runListQuerySchema,
  updateSyncJobSchema,
  FIELD_TYPES,
  TRANSFORM_TYPES,
} from '@syncfix/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';
import { assertMappingInput } from '../../services/mapping.service.js';

const jobParams = z.object({
  organizationId: idParamSchema.shape.id,
  jobId: idParamSchema.shape.id,
});

const mappingsBody = z.object({
  mappings: z.array(z.record(z.string(), z.unknown())).max(200),
});

const validateBody = z.object({
  mappings: z.array(z.record(z.string(), z.unknown())).max(200),
  sampleSourceFields: z.array(z.string().max(200)).max(200).optional(),
};

const previewBody = z.object({
  filename: z.string().trim().min(1).max(200),
  csv: z.string().min(1, 'The CSV file is empty').max(2 * 1024 * 1024, 'The file is larger than 2 MB'),
  mapping: z.record(z.string(), z.string().trim().min(1).max(64)).default({}),
};

export function syncJobsRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: runListQuerySchema }),
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
    requirePermission('sync_job.create'),
    validate({ body: createSyncJobSchema }),
    asyncHandler(async (req, res) => {
      const job = await services.syncJobs.create({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        ...(req.body as never),
      });
      res.status(201).json({ job });
    }),
  );

  router.get(
    '/:jobId',
    validate({ params: { jobId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      res.json(await services.syncJobs.get(req.organization!.id, req.params.jobId as string));
    }),
  );

  router.patch(
    '/:jobId',
    requirePermission('sync_job.edit'),
    validate({ params: { jobId: idParamSchema.shape.id }, body: updateSyncJobSchema }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.syncJobs.update(
          req.organization!.id,
          req.params.jobId as string,
          req.principal!.user.id,
          req.body as never,
        ),
      );
    }),
  );

  router.post(
    '/:jobId/run',
    requirePermission('sync_job.run'),
    validate({ params: { jobId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      const run = await services.syncJobs.run({
        organizationId: req.organization!.id,
        jobId: req.params.jobId as string,
        actorUserId: req.principal!.user.id,
        dryRun: req.body?.dryRun ?? false,
        requestId: req.requestId,
      });
      res.json({ run });
    }),
  );

  router.get(
    '/:jobId/runs',
    validate({ params: { jobId: idParamSchema.shape.id }, query: runListQuerySchema }),
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

  router.post(
    '/:jobId/runs/:runId/retry',
    requirePermission('sync_job.run'),
    validate({ params: { jobId: idParamSchema.shape.id, runId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      const run = await services.syncJobs.retry({
        organizationId: req.organization!.id,
        jobId: req.params.jobId as string,
        runId: req.params.runId as string,
        actorUserId: req.principal!.user.id,
      });
      res.json({ run });
    }),
  );

  router.delete(
    '/:jobId',
    requirePermission('sync_job.delete'),
    validate({ params: { jobId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      await services.syncJobs.archive({
        organizationId: req.organization!.id,
        jobId: req.params.jobId as string,
        actorUserId: req.principal!.user.id,
      });
      res.status(204).end();
    }),
  );

  router.post(
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
          sourceType: mapping.sourceType as 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json',
          destinationType: mapping.destinationType as 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json',
          transformType: mapping.transformType as 'none' | 'trim' | 'uppercase' | 'lowercase' | 'truncate' | 'replace' | 'extract' | 'concat' | 'split' | 'join' | 'hash' | 'mask' | 'template' | 'json_parse' | 'json_stringify' | 'date_format' | 'date_parse' | 'number_format',
          transformConfig: mapping.transformConfig,
          required: mapping.required,
          ...(mapping.defaultValue !== null ? { defaultValue: mapping.defaultValue } : {}),
          sortOrder: mapping.sortOrder,
        }),
        fixture: (req.body as { fixture: Array<Record<string, unknown>> }).fixture,
      });
      res.json(preview);
    }),
  );

  router.post(
    '/:jobId/mappings/commit',
    requirePermission('mapping.manage'),
    validate({ params: jobParams, body: importCommitSchema }),
    asyncHandler(async (req, res) => {
      const jobId = req.params.jobId as string;
      await services.syncJobs.requireOwned(req.organization!.id, jobId);
      const result = await services.syncJobs.commitMappings({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        jobId: req.params.jobId as string,
        mappings: req.body.mappings,
      });
      res.json({ result });
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

  router.get(
    '/:jobId/mappings/:mappingId',
    validate({ params: { jobId: idParamSchema.shape.id, mappingId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      await services.syncJobs.requireOwned(req.organization!.id, req.params.jobId as string);
      const mapping = await services.syncJobs.getMapping(
        req.organization!.id,
        req.params.mappingId as string,
      );
      res.json({ mapping });
    }),
  );

  router.delete(
    '/:jobId/mappings/:mappingId',
    requirePermission('mapping.manage'),
    validate({ params: { jobId: idParamSchema.shape.id, mappingId: idParamSchema.shape.id } }),
    asyncHandler(async (req, res) => {
      await services.syncJobs.deleteMapping(
        req.organization!.id,
        req.params.mappingId as string,
        req.principal!.user.id,
      );
      res.status(204).end();
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
`;

// Write the file with explicit line endings
import fs from 'fs';
fs.writeFileSync('server/src/http/routes/sync-jobs.ts', content.replace(/\r\n/g, '\n'), 'utf8');
console.log('File written successfully');