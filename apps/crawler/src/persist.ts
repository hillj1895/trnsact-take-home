import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { facetHashes, Unit, type SourceConfig } from '@trnsact/core';
import { applyRun, recordRun, stageUnits, upsertSource, type ApplyStats, type Pool } from '@trnsact/db';
import type { RunSummary } from './summary.js';

/**
 * Crawl output → database: register source, record the run, stage its units with
 * facet hashes, then apply the set-based diff. Same path for live crawls, imports
 * of saved runs, and the replay demo.
 */
export async function persistRun(db: Pool, config: SourceConfig, summary: RunSummary, units: Unit[]): Promise<ApplyStats> {
  await upsertSource(db, config);
  await recordRun(db, {
    id: summary.runId,
    sourceId: config.id,
    configVersion: config.version,
    status: 'succeeded',
    healthy: summary.health.healthy,
    partial: summary.partial,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    summary,
  });
  const ignoreSpecs = config.detail?.hashIgnoreSpecs ?? [];
  await stageUnits(db, summary.runId, units.map((unit) => ({ unit, hashes: facetHashes(unit, { ignoreSpecs }) })));
  return applyRun(db, summary.runId);
}

/** Load a previous run's output directory (summary.json + units.ndjson). */
export async function loadRunDir(dir: string): Promise<{ summary: RunSummary; units: Unit[] }> {
  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')) as RunSummary;
  summary.partial ??= summary.health.reasons.some((r) => r.startsWith('partial run')); // pre-`partial` summaries
  const units = (await readFile(path.join(dir, 'units.ndjson'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => Unit.parse(JSON.parse(line)));
  return { summary, units };
}
