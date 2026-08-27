import express, { type Express } from 'express';
import { env } from './config/env.js';
import { connectAll, healthCheck } from './config/db.js';
import { logger } from './lib/logger.js';

export function createApp(): Express {
  const app = express();

  // NOTE: express.json() is applied per-route, NOT globally. The OpenWA webhook
  // needs the RAW request bytes to verify its HMAC signature, and a global JSON
  // parser consumes them. See messaging/webhook.ts.
  app.get('/health', async (_req, res) => {
    const report = await healthCheck();
    res.status(report.ok ? 200 : 503).json(report);
  });

  return app;
}

async function main() {
  await connectAll();
  const app = createApp();
  app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scalivo backend listening'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
