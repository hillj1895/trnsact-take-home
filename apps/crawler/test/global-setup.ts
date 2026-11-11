import { createPool, resetDatabase } from '@trnsact/db';

/** Once per test run: fresh schema on the throwaway scenario DB (if configured). */
export async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const pool = createPool(url);
  try {
    await resetDatabase(pool);
  } finally {
    await pool.end();
  }
}
