import type { SourceConfig, Unit } from '@trnsact/core';
import type { HttpStats } from '@trnsact/http';

export interface RunSummaryInput {
  runId: string;
  config: SourceConfig;
  startedAt: Date;
  finishedAt: Date;
  partial: boolean;
  siteTotal?: number;
  discovered: number;
  duplicateKeys: number;
  listPages: number;
  listErrors: number;
  processed: number;
  detailRequested: number;
  detailFailed: number;
  invalid: number;
  units: Unit[];
  http: HttpStats;
  outputDir: string;
}

export type RunSummary = ReturnType<typeof summarize>;

const TRACKED_FIELDS = [
  'stockNumber',
  'vin',
  'year',
  'make',
  'model',
  'category',
  'mileage',
  'hours',
  'location',
  'availabilityRaw',
] as const satisfies readonly (keyof Unit)[];

/** Thresholds a run must meet before downstream diffing may treat a missing unit as "removed". */
const HEALTH = { minCoverage: 0.95, maxInvalidRate: 0.02, maxDetailFailRate: 0.05 };

/**
 * Per-run metrics. These are the monitoring signals at scale: coverage vs. the
 * site's own count, field fill rates (a drop = layout change), error rates.
 */
export function summarize(i: RunSummaryInput) {
  const n = i.units.length || 1;
  const fill = (pred: (u: Unit) => boolean) => round(i.units.filter(pred).length / n);
  const fillRates: Record<string, number> = {};
  for (const f of TRACKED_FIELDS) fillRates[f] = fill((u) => u[f] !== undefined && u[f] !== '');
  fillRates.price = fill((u) => u.price.amount !== null);
  fillRates.knownAvailability = fill((u) => u.availability !== 'unknown');
  fillRates.knownCondition = fill((u) => u.condition !== 'unknown');
  fillRates.hasImages = fill((u) => u.media.some((m) => m.kind === 'image'));
  fillRates.hasSpecs = fill((u) => Object.keys(u.specs).length > 0);

  const coverage = i.siteTotal ? round(i.discovered / i.siteTotal) : undefined;
  const invalidRate = i.processed ? round(i.invalid / i.processed) : 0;
  const detailFailRate = i.detailRequested ? round(i.detailFailed / i.detailRequested) : 0;

  const reasons: string[] = [];
  if (i.listErrors) reasons.push('list page failure (inventory view incomplete)');
  if (i.discovered === 0) reasons.push('zero units discovered');
  if (coverage !== undefined && coverage < HEALTH.minCoverage) reasons.push(`coverage ${coverage} < ${HEALTH.minCoverage}`);
  if (invalidRate > HEALTH.maxInvalidRate) reasons.push(`invalid rate ${invalidRate}`);
  if (detailFailRate > HEALTH.maxDetailFailRate) reasons.push(`detail failure rate ${detailFailRate}`);
  if (i.partial) reasons.push('partial run (--limit/--max-pages): not eligible for removal detection');

  const warningCounts: Record<string, number> = {};
  for (const u of i.units) {
    for (const w of u.warnings) {
      const bucket = w.replace(/"[^"]*"/g, '"…"');
      warningCounts[bucket] = (warningCounts[bucket] ?? 0) + 1;
    }
  }

  const availability: Record<string, number> = {};
  for (const u of i.units) availability[u.availability] = (availability[u.availability] ?? 0) + 1;

  return {
    runId: i.runId,
    sourceId: i.config.id,
    dealerId: i.config.dealer.id,
    configVersion: i.config.version,
    driver: i.config.driver,
    startedAt: i.startedAt.toISOString(),
    finishedAt: i.finishedAt.toISOString(),
    durationMs: i.finishedAt.getTime() - i.startedAt.getTime(),
    counts: {
      siteTotal: i.siteTotal,
      discovered: i.discovered,
      duplicateKeys: i.duplicateKeys,
      listPages: i.listPages,
      processed: i.processed,
      valid: i.units.length,
      invalid: i.invalid,
      detailFailed: i.detailFailed,
      images: i.units.reduce((a, u) => a + u.media.filter((m) => m.kind === 'image').length, 0),
      videos: i.units.reduce((a, u) => a + u.media.filter((m) => m.kind === 'video').length, 0),
      documents: i.units.reduce((a, u) => a + u.media.filter((m) => m.kind === 'document').length, 0),
    },
    availability,
    health: { healthy: reasons.length === 0, coverage, invalidRate, detailFailRate, reasons },
    fillRates,
    warningCounts,
    http: i.http,
    outputDir: i.outputDir,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
