/**
 * Adapter registry (Part D / D8).
 *
 * This registry is the single source of truth for what SyncFix supports. It
 * intentionally contains exactly two entries, both fully implemented and
 * tested:
 *
 *   - `rest`          generic REST connector with strict SSRF protection,
 *   - `webhook_ingest` generic signed webhook ingestion.
 *
 * There is deliberately NO list of named SaaS vendors. SyncFix does not
 * implement OAuth flows, vendor token exchanges or vendor-specific endpoints,
 * so advertising them would be a lie. Any system is reached through one of the
 * two adapters above with an explicitly configured, documented endpoint.
 */

import type { ProviderDescriptor } from '@syncfix/shared';

import { RestConnectorAdapter } from './rest.js';
import { WebhookIngestAdapter } from './webhook-ingest.js';
import type { ConnectorAdapter } from './types.js';

export function createAdapter(provider: string, knownFields?: Record<string, string[]>): ConnectorAdapter {
  switch (provider) {
    case 'rest':
      return new RestConnectorAdapter(knownFields ? { knownFields } : {});
    case 'webhook_ingest':
      return new WebhookIngestAdapter();
    default:
      throw new Error(
        `No adapter is registered for provider "${provider}". SyncFix ships only "rest" and "webhook_ingest".`,
      );
  }
}

const ADAPTERS: Array<() => ConnectorAdapter> = [
  () => new RestConnectorAdapter(),
  () => new WebhookIngestAdapter(),
];

/** Catalogue for the UI. Everything here is real and tested. */
export function providerCatalogue(): ProviderDescriptor[] {
  return ADAPTERS.map((factory) => {
    const adapter = factory();
    return {
      provider: adapter.provider,
      kind: adapter.kind,
      displayName: adapter.displayName,
      available: true,
      description:
        adapter.kind === 'rest'
          ? 'Reads and writes any documented REST API. Requires an explicit https base URL that you control.'
          : 'Receives signed, timestamped webhook events from any system that can compute an HMAC signature.',
      authOptions:
        adapter.kind === 'rest'
          ? ['none', 'bearer', 'api_key_header', 'basic']
          : ['hmac_sha256'],
      supportsWrite: adapter.capabilities.supportsWrite,
      guarantees: [...adapter.guarantees],
      limitations: [...adapter.limitations],
      setupSteps: [...adapter.setupSteps],
      docsUrl: null,
    };
  });
}

/** Which connectors are push-only and therefore cannot be a job destination. */
export function supportsDestinationWrite(provider: string): boolean {
  try {
    return createAdapter(provider).capabilities.supportsWrite;
  } catch {
    return false;
  }
}

export function supportedProviders(): string[] {
  return ADAPTERS.map((factory) => factory().provider);
}

export * from './types.js';
export { RestConnectorAdapter } from './rest.js';
export { WebhookIngestAdapter } from './webhook-ingest.js';