import pg from 'pg';

export { migrate, resetDatabase, MIGRATIONS_DIR } from './migrate.js';
export { recordRun, stageUnits, upsertSource, type RunRecord, type StagedUnit } from './runs.js';
export { applyRun, type ApplyStats } from './apply.js';

// numeric → JS number (values here are prices/mileage, well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new pg.Pool({ connectionString, max: 5 });
}

export type { Pool, PoolClient } from 'pg';
