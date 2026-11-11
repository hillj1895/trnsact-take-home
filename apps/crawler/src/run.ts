import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger, SourceConfig, Unit } from '@trnsact/core';
import { getDriver, normalizeUnit, type DetailResult, type ListingStub } from '@trnsact/extract';
import { HttpClient } from '@trnsact/http';
import { summarize, type RunSummary } from './summary.js';

export interface CrawlOptions {
  outDir: string;
  logger: Logger;
  /** Cap list pages per start URL. */
  maxPages?: number;
  /** Only process the first N discovered units (detail + output). */
  limit?: number;
  /** Fetch detail pages (default true if the config defines detail). */
  detail?: boolean;
  /** Injectable clock: run start time, and so every event/history timestamp (tests simulate nights with it). */
  now?: () => Date;
}

/**
 * One source, end to end: discover → (detail) → normalize → validate → write.
 * Output is NDJSON + a run summary; persistence/diffing plugs in after normalize.
 */
export interface CrawlResult {
  summary: RunSummary;
  units: Unit[];
}

export async function crawlSource(config: SourceConfig, opts: CrawlOptions): Promise<CrawlResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = `${config.id}-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const logger = opts.logger.child({ runId, sourceId: config.id, configVersion: config.version });
  const http = new HttpClient({ ...config.http, logger });
  const driver = getDriver(config.driver);
  const ctx = { config, http, logger };

  const runDir = path.join(opts.outDir, config.id, runId);
  await mkdir(runDir, { recursive: true });
  const unitsOut = createWriteStream(path.join(runDir, 'units.ndjson'));
  const errorsOut = createWriteStream(path.join(runDir, 'errors.ndjson'));
  const writeLine = (s: WriteStream, obj: unknown) => s.write(JSON.stringify(obj) + '\n');

  logger.info('run.start', { driver: driver.name, maxPages: opts.maxPages, limit: opts.limit });

  // 1. Discovery
  const stubs = new Map<string, ListingStub>();
  const siteTotals = new Map<string, number>();
  let listPages = 0;
  let listErrors = 0;
  let duplicateKeys = 0;
  try {
    for await (const page of driver.discover(ctx, { maxPages: opts.maxPages })) {
      listPages++;
      if (page.siteTotal !== undefined) {
        // One total per search (start URL), keyed by path so ?page=N collapses.
        siteTotals.set(new URL(page.pageUrl).pathname, page.siteTotal);
      }
      for (const stub of page.stubs) {
        if (stubs.has(stub.key)) {
          duplicateKeys++;
          continue;
        }
        stubs.set(stub.key, stub);
      }
    }
  } catch (err) {
    // A failed list page means our view of inventory is incomplete. Record it;
    // the summary will mark the run unhealthy so nothing downstream treats
    // missing units as removed.
    listErrors++;
    logger.error('list.failed', { error: (err as Error).message });
    writeLine(errorsOut, { stage: 'list', error: (err as Error).message });
  }

  const selected = [...stubs.values()].slice(0, opts.limit ?? Infinity);
  const wantDetail = (opts.detail ?? true) && (config.detail?.enabled ?? false);
  logger.info('discovery.done', { discovered: stubs.size, selected: selected.length, listPages, wantDetail });

  // 2. Detail + normalize, bounded concurrency (the HttpClient also rate-limits).
  const units: Unit[] = [];
  let detailFailed = 0;
  let invalid = 0;
  const scrapedAt = now().toISOString();

  await forEachPool(selected, config.http.concurrency, async (stub) => {
    let detail: DetailResult | undefined;
    if (wantDetail) {
      try {
        detail = await driver.fetchDetail(ctx, stub);
      } catch (err) {
        // Degrade, don't drop: list data alone still proves the unit exists
        // and carries price/availability.
        detailFailed++;
        stub.warnings.push(`detail fetch failed: ${(err as Error).message}`);
        writeLine(errorsOut, { stage: 'detail', key: stub.key, url: stub.url, error: (err as Error).message });
      }
    }
    const detailStatus = !config.detail?.enabled ? undefined : !wantDetail ? 'skipped' : detail ? 'ok' : 'failed';
    const result = normalizeUnit(config, stub, detail, scrapedAt, { detailStatus });
    if (result.ok) {
      units.push(result.unit);
      writeLine(unitsOut, result.unit);
    } else {
      invalid++;
      writeLine(errorsOut, { stage: 'normalize', key: stub.key, url: stub.url, errors: result.errors, partial: result.partial });
    }
  });

  await Promise.all([closeStream(unitsOut), closeStream(errorsOut)]);

  const summary = summarize({
    runId,
    config,
    startedAt,
    finishedAt: now(),
    partial: opts.limit !== undefined || opts.maxPages !== undefined,
    siteTotal: siteTotals.size ? [...siteTotals.values()].reduce((a, b) => a + b, 0) : undefined,
    discovered: stubs.size,
    duplicateKeys,
    listPages,
    listErrors,
    processed: selected.length,
    detailRequested: wantDetail ? selected.length : 0,
    detailFailed,
    invalid,
    units,
    http: http.stats,
    outputDir: runDir,
  });
  await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  logger.info('run.done', { healthy: summary.health.healthy, reasons: summary.health.reasons, units: units.length });
  return { summary, units };
}

async function forEachPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function closeStream(s: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => s.end((err?: Error | null) => (err ? reject(err) : resolve())));
}
