import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// TEST_DATABASE_URL may live in the repo-root .env (scenarios + DB tests skip without it).
const env = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(env)) process.loadEnvFile(env);

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
  },
});
