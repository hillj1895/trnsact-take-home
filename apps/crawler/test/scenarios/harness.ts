import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { SourceConfig, type Logger } from '@trnsact/core';
import { createPool, type ApplyStats, type Pool } from '@trnsact/db';
import { MockDealer, type MockDealerOptions } from '@trnsact/testkit';
import { SOURCES_DIR } from '../../src/paths.js';
import { persistRun } from '../../src/persist.js';
import { crawlSource, type CrawlOptions } from '../../src/run.js';
import type { RunSummary } from '../../src/summary.js';

/**
 * Scenario harness: "what does the system do when the dealer's site changes like X?"
 *
 * Each scenario gets its own mock dealer site, its own source id (so scenarios
 * are isolated and can run in parallel on one DB), and a simulated clock where
 * every `night()` is one day later. A night is the real pipeline — HTTP crawl of
 * the mock site with the REAL `sources/transwest.json` (only baseUrl and rate
 * limits swapped) → normalize → persistRun → applyRun — and returns the summary,
 * apply stats and the events it wrote.
 *
 * Needs Postgres: set TEST_DATABASE_URL (throwaway DB; reset once per test run
 * by test/global-setup.ts). Without it, scenarios are skipped.
 */
export const TEST_DB = process.env.TEST_DATABASE_URL;

export interface EventRow {
  stock: string;
  type: string;
  changes: Record<string, any>;
}

export interface Night {
  n: number;
  at: Date;
  runId: string;
  summary: RunSummary;
  stats: ApplyStats;
  /** Events written by this night, ordered by stock number then type. */
  events: EventRow[];
  /** Event types per stock number, e.g. `{ MK0001: ['PRICE_CHANGED'] }` — compact for assertions. */
  types: Record<string, string[]>;
}

const DAY = 24 * 3600 * 1000;
const EPOCH = Date.UTC(2026, 0, 1, 2); // nights run at 02:00 UTC

const transwest = JSON.parse(await readFile(path.join(SOURCES_DIR, 'transwest.json'), 'utf8'));

export class Scenario {
  readonly config: SourceConfig;
  readonly logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  private n = -1;

  constructor(
    readonly site: MockDealer,
    readonly db: Pool,
    readonly sourceId: string,
    private readonly outDir: string,
  ) {
    this.config = SourceConfig.parse({
      ...transwest,
      id: sourceId,
      dealer: { id: sourceId, name: `Mock dealer (${sourceId})` },
      baseUrl: site.url,
      http: { ...transwest.http, timeoutMs: 5000, retries: 2 },
    });
    // Same extraction config as production; only politeness limits relaxed for
    // localhost. Set after parse on purpose: the schema caps real configs at 10 rps.
    this.config.http.requestsPerSecond = 500;
    this.config.http.concurrency = 4;
  }

  /** Crawl the mock site as the next night and apply the run. */
  async night(opts: Pick<CrawlOptions, 'limit' | 'maxPages' | 'detail'> = {}): Promise<Night> {
    const n = ++this.n;
    if (n > 0) this.site.nextNight();
    const wall = Date.now();
    const at = new Date(EPOCH + n * DAY);
    const { summary, units } = await crawlSource(this.config, {
      ...opts,
      outDir: this.outDir,
      logger: this.logger(),
      now: () => new Date(at.getTime() + (Date.now() - wall)),
    });
    const stats = await persistRun(this.db, this.config, summary, units);
    const events = (
      await this.db.query<EventRow>(
        `SELECT u.stock_number AS stock, e.type, e.changes
         FROM unit_events e JOIN units u ON u.id = e.unit_id
         WHERE e.run_id = $1 ORDER BY u.stock_number, e.type`,
        [summary.runId],
      )
    ).rows;
    const types: Record<string, string[]> = {};
    for (const e of events) (types[e.stock] ??= []).push(e.type);
    return { n, at, runId: summary.runId, summary, stats, events, types };
  }

  /** Current-state row for a unit (by stock number). */
  async unit(stock: string) {
    return (await this.db.query(`SELECT * FROM units WHERE source_id = $1 AND stock_number = $2`, [this.sourceId, stock])).rows[0];
  }

  async unitStatuses(): Promise<Record<string, number>> {
    const rows = (
      await this.db.query(`SELECT status, count(*)::int AS n FROM units WHERE source_id = $1 GROUP BY status`, [this.sourceId])
    ).rows;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Point-in-time price (amount) for a unit. */
  async priceAt(stock: string, at: Date): Promise<number | null | undefined> {
    const row = (
      await this.db.query(
        `SELECT h.amount FROM unit_price_history h JOIN units u ON u.id = h.unit_id
         WHERE u.source_id = $1 AND u.stock_number = $2 AND h.valid @> $3::timestamptz`,
        [this.sourceId, stock, at],
      )
    ).rows[0];
    return row ? row.amount : undefined;
  }

  /** Midpoint between two nights — "what did we believe yesterday afternoon?" */
  static between(a: Night, b: Night): Date {
    return new Date((a.at.getTime() + b.at.getTime()) / 2);
  }

  private logger(): Logger {
    const make = (base: Record<string, unknown>): Logger => {
      const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => this.logs.push({ level, msg, fields: { ...base, ...fields } });
      return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'), child: (f) => make({ ...base, ...f }) };
    };
    return make({});
  }
}

let seq = 0;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

/**
 * `describe` block whose `scenario(name, fn, siteOpts?)` registers one isolated,
 * individually runnable scenario:  pnpm test:scenarios -t "price cut"
 */
export function describeScenarios(title: string, body: (scenario: (name: string, fn: (s: Scenario) => Promise<void>, site?: MockDealerOptions) => void) => void) {
  describe.skipIf(!TEST_DB)(title, () => {
    let db: Pool;
    beforeAll(() => {
      db = createPool(TEST_DB);
    });
    afterAll(async () => db?.end());

    body((name, fn, siteOpts) => {
      it(name, async () => {
        const site = await new MockDealer(siteOpts).start();
        const outDir = await mkdtemp(path.join(os.tmpdir(), 'scenario-'));
        try {
          await fn(new Scenario(site, db, `mock-${slug(name)}-${process.pid}-${++seq}`, outDir));
        } finally {
          await site.close();
          await rm(outDir, { recursive: true, force: true });
        }
      });
    });
  });
}
