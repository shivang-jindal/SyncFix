/**
 * Public, signature-verified ingestion route (Part D / D5, D7).
 *
 * This route is mounted BEFORE authentication and is the only unauthenticated
 * write endpoint. It:
 *
 *  - verifies the HMAC-SHA256 signature over `${timestamp}.${rawBody}`,
 *  - rejects a timestamp outside the tolerance window (replay protection),
 *  - rate limits per endpoint,
 *  - deduplicates by external event id (or payload hash),
 *  - stores only a redacted payload,
 *  - never logs the signing secret and never echoes it back.
 *
 * The raw-body parser is mounted at the app level (see app.ts) because the
 * signature covers the exact bytes and JSON re-serialisation would change them.
 */

import { Router, type Request } from 'express';

import type { Services } from '../../container.js';
import { badRequest } from '../../errors.js';
import { hashText } from '../../lib/stable-hash.js';

export const INGEST_MAX_BODY_BYTES = 1_048_576;

export function ingestRouter(services: Services): Router {
  const router = Router();

  router.post(
    '/:publicEndpointId',
    async (req: Request, res, next) => {
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        if (!rawBody) throw badRequest('The request body is empty.');

        const headers: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = value as string | string[] | undefined;
        }

        const result = await services.webhooks.ingestForEndpoint(
          req.params.publicEndpointId!,
          { rawBody, headers },
        );

        if (result.status === 'accepted') {
          // Processing happens in the queue, so the sender is answered quickly.
          await services.jobs.enqueue({
            jobType: 'webhook.process',
            organizationId: result.organizationId,
            payload: { organizationId: result.organizationId, eventId: result.eventId },
            // One processing job per event, ever.
            idempotencyKey: `webhook.process:${result.eventId}`,
          });
        }

        res.status(result.status === 'accepted' ? 202 : 200).json({
          status: result.status,
          eventId: result.eventId,
          payloadHash: hashText(rawBody).slice(0, 16),
          message: result.message,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}