import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import type { Services } from './container.js';
import { createApiRouter, errorHandler, notFoundHandler } from './http/routes/index.js';
import { INGEST_MAX_BODY_BYTES } from './http/routes/ingest.js';
import { requestContext } from './http/middleware.js';

export function createApp(services: Services): Express {
  const app = express();

  app.set('trust proxy', services.config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API only ever returns JSON, never HTML with inline scripts.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests have no Origin header.
        if (!origin) {
          callback(null, true);
          return;
        }
        callback(null, services.config.allowedOrigins.includes(origin));
      },
      credentials: true,
      exposedHeaders: ['Content-Disposition', 'X-Request-Id'],
    }),
  );

  // Webhook ingestion needs the RAW body for signature verification, so this
  // parser is mounted before the JSON parser and only for that path.
  app.use('/api/v1/ingest', express.raw({ type: '*/*', limit: INGEST_MAX_BODY_BYTES }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  app.use(requestContext(services.config));

  app.use(
    '/api/v1',
    rateLimit({
      windowMs: services.config.rateLimit.windowMs,
      limit: services.config.rateLimit.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health'),
    }),
  );

  // Ingestion has its own per-endpoint budget inside the webhook service.
  app.use('/api/v1/ingest', (req, res, next) => {
    if (req.method !== 'POST') return next();
    res.setHeader('cache-control', 'no-store');
    next();
  });

  app.use('/api/v1', createApiRouter(services));

  app.use(notFoundHandler());
  app.use(errorHandler(services));

  return app;
}