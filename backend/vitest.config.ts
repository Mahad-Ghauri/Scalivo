import { defineConfig } from 'vitest/config';

// env.ts fails fast on missing config, which is correct at boot but means tests
// need a valid set. These are fakes — no test here touches a real datastore.
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      MONGO_URI: 'mongodb://localhost:27017/scalivo-test?replicaSet=rs0',
      POSTGRES_URL: 'postgres://scalivo:scalivo@localhost:5432/scalivo',
      REDIS_URL: 'redis://localhost:6379',
      OPENWA_BASE_URL: 'http://localhost:2785',
      OPENWA_API_KEY: 'owa_k1_test',
      OPENWA_WEBHOOK_SECRET: 'test-webhook-secret-value',
      JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
    },
  },
});
