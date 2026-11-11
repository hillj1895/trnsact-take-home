import type pg from 'pg';
import type { FacetHashes, SourceConfig, Unit } from '@trnsact/core';

export async function upsertSource(db: pg.Pool | pg.PoolClient, config: SourceConfig): Promise<void> {
  await db.query(
    `INSERT INTO dealers (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
    [config.dealer.id, config.dealer.name],
  );
  await db.query(
    `INSERT INTO sources (id, dealer_id, driver, base_url, config, config_version, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       dealer_id = excluded.dealer_id, driver = excluded.driver, base_url = excluded.base_url,
       config = excluded.config, config_version = excluded.config_version,
       enabled = excluded.enabled, updated_at = now()`,
    [config.id, config.dealer.id, config.driver, config.baseUrl, config, config.version, config.enabled],
  );
}

export interface RunRecord {
  id: string;
  sourceId: string;
  configVersion: number;
  status: 'running' | 'succeeded' | 'failed';
  healthy: boolean | null;
  partial: boolean;
  startedAt: string;
  finishedAt?: string;
  summary?: unknown;
}

export async function recordRun(db: pg.Pool | pg.PoolClient, run: RunRecord): Promise<void> {
  await db.query(
    `INSERT INTO crawl_runs (id, source_id, config_version, status, healthy, partial, started_at, finished_at, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, healthy = excluded.healthy, partial = excluded.partial,
       finished_at = excluded.finished_at, summary = excluded.summary`,
    [run.id, run.sourceId, run.configVersion, run.status, run.healthy, run.partial, run.startedAt, run.finishedAt ?? null, run.summary ?? null],
  );
}

export interface StagedUnit {
  unit: Unit;
  hashes: FacetHashes;
}

/**
 * Bulk-load a run's units into the unlogged staging table: one multi-row INSERT
 * per batch via unnest() of parallel arrays. (In production: COPY FROM the run's
 * NDJSON in S3, same table.)
 */
export async function stageUnits(db: pg.Pool | pg.PoolClient, runId: string, staged: StagedUnit[], batchSize = 500) {
  for (let i = 0; i < staged.length; i += batchSize) {
    const batch = staged.slice(i, i + batchSize);
    await db.query(
      `INSERT INTO staged_units (run_id, source_unit_key, data, details_hash, price_hash, media_hash, availability)
       SELECT $1, * FROM unnest($2::text[], $3::jsonb[], $4::bytea[], $5::bytea[], $6::bytea[], $7::availability[])
       ON CONFLICT (run_id, source_unit_key) DO NOTHING`,
      [
        runId,
        batch.map((s) => s.unit.sourceUnitKey),
        batch.map((s) => JSON.stringify(s.unit)),
        batch.map((s) => s.hashes.details),
        batch.map((s) => s.hashes.price),
        batch.map((s) => s.hashes.media),
        batch.map((s) => s.unit.availability),
      ],
    );
  }
}
