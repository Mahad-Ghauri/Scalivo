import type { MessagingProvider } from '@scalivo/shared';
import { env } from '../config/env.js';
import { OpenWAProvider } from './OpenWAProvider.js';
import { MetaCloudProvider } from './MetaCloudProvider.js';

/**
 * The only place in the codebase that names a concrete provider.
 *
 * Everything above this line takes a MessagingProvider. An eslint
 * no-restricted-imports rule fails the build if any other file imports
 * OpenWAProvider directly, so the Phase 0 "no business logic knows the
 * provider" requirement is enforced rather than remembered.
 */
export function createMessagingProvider(): MessagingProvider {
  switch (env.MESSAGING_PROVIDER) {
    case 'openwa':
      return new OpenWAProvider(env.OPENWA_BASE_URL, env.OPENWA_API_KEY, env.OPENWA_WEBHOOK_SECRET);
    case 'meta':
      return new MetaCloudProvider();
  }
}

export { InvalidSignatureError } from './OpenWAProvider.js';
export { createWebhookRouter } from './webhook.js';
