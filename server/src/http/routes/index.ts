/**
 * API router assembly (Part A / A7): everything lives under `/api/v1`.
 */

import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';

import type { Services } from '../../container.js';
import { AppError } from '../../errors.js';
import {
  asyncHandler,
  requireAuth,
  requireAuthenticated,
  requireOrganization,
} from '../middleware.js';
import { authRouter } from './auth.js';
import { connectionRouter } from './connections.js';
import { healthRouter } from './health.js';
import { ingestRouter } from './ingest.js';
import { issueRouter } from './issues.js';
import { organizationRouter } from './organization.js';
import { reportRouter } from './reporting.js';
import { runRouter } from './sync-runs.js';
import { syncJobRouter } from './sync-jobs.js';
import { webhookEndpointRouter } from './webhook-endpoints.js';

export function createApiRouter(services: Services): Router {
  const router = Router();

  router.use('/health', healthRouter(services));

  // The ingest route is authenticated by its HMAC signature, not by a session.
  router.use('/ingest', ingestRouter(services));

  // Resolve the session (when present) for every route, including `/auth`,
  // whose `/session` endpoint must be able to see the cookie. This middleware
  // never rejects — the guard below does that for everything past `/auth`.
  router.use(requireAuth(services));

  router.use('/auth', authRouter(services));

  // Every remaining route requires a session.
  router.use(requireAuthenticated());

  router.get(
    '/session/context',
    asyncHandler(async (req, res) => {
      const memberships = await services.auth.membershipsFor(req.principal!.user.id);
      res.json({
        user: req.principal!.user,
        memberships,
        activeOrganizationId: req.principal!.activeOrganizationId,
      });
    }),
  );

  // `mergeParams` is required so `:organizationId` from the mount path is
  // visible to `requireOrganization` inside the sub-router.
  const organizationScoped = Router({ mergeParams: true });
  organizationScoped.use(requireOrganization(services));

  organizationScoped.use('/connections', connectionRouter(services));
  organizationScoped.use('/sync-jobs', syncJobRouter(services));
  organizationScoped.use('/sync-runs', runRouter(services));
  organizationScoped.use('/issues', issueRouter(services));
  organizationScoped.use('/webhook-endpoints', webhookEndpointRouter(services));
  organizationScoped.use('/', organizationRouter(services));
  organizationScoped.use('/reports', reportRouter(services));

  router.use('/:organizationId', organizationScoped);

  return router;
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.path}.`,
        requestId: req.requestId,
      },
    });
  };
}

/** One error shape for the whole API; stack traces stay in the log only. */
export function errorHandler(services: Services): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) return;

    if (error instanceof AppError) {
      if (error.status >= 500) {
        services.logger.error({ err: error, requestId: req.requestId }, 'request failed');
      } else {
        services.logger.debug(
          { code: error.code, requestId: req.requestId, path: req.path },
          'request rejected',
        );
      }
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Something went wrong. Please try again.',
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    // Zod errors that escaped an explicit validate() call.
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some of the values you entered are not valid.',
          issues: issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is not valid JSON.',
          requestId: req.requestId,
        },
      });
      return;
    }

    services.logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId: req.requestId,
      },
    });
  };
}