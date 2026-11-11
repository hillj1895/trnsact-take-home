import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, type SourceConfig } from '@trnsact/core';
import { getDriver, normalizeUnit, parseListPage } from '@trnsact/extract';
import { HttpClient } from '@trnsact/http';
import { createPool, migrate, resetDatabase, type ApplyStats } from '@trnsact/db';
import { FileConfigStore } from './config-store.js';
import { exportDatabase } from './export.js';
import { simulateWeek, writeSimulationReadme } from './simulate.js';
import { OUTPUT_DIR, REPO_ROOT, SOURCES_DIR } from './paths.js';
import { loadRunDir, persistRun } from './persist.js';
import { crawlSource } from './run.js';

// Load .env from the repo root if present (DATABASE_URL etc.).
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  /* no .env — rely on the real environment */
}

const USAGE = `
Usage: pnpm <script> [args]

  crawl <sourceId|all> [--max-pages N] [--limit N] [--no-detail] [--out DIR] [--no-persist]
                        [--base-url URL]
      Run a full crawl for one source (or every enabled source). When DATABASE_URL is set,
      the run is persisted and change-detected (unless --no-persist). --base-url points the
      config at another host (e.g. \`pnpm mock:serve\`) and implies --no-persist.

  import <runDir>                   Persist a saved run directory (summary.json + units.ndjson).
  simulate [runDir] [--reset] [--out DIR]
      Seed the mock dealer site with a real crawl (default: latest full run), run a scripted
      week through the full pipeline, and export the DB to DIR (default exports/).
      Needs an empty DB (--reset wipes it).
  export [sourceId] [--out DIR]     Export the DB (units, events, price/availability history,
                                    media, runs) as CSV + NDJSON.
  db:migrate                        Apply pending SQL migrations.
  db:reset                          Drop and re-create the schema (local only).

  probe <sourceId> [--limit N] [--base-url URL]
      Live check while authoring a config: fetch list page 1 and N detail pages,
      print normalized units to stdout. Writes nothing.

  sources:list                      List configs and whether they validate.
  sources:validate                  Validate every config; non-zero exit on failure (CI gate).
  fixtures:capture <sourceId>       Save list page 1 + first detail page as offline test fixtures.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'max-pages': { type: 'string' },
      limit: { type: 'string' },
      'no-detail': { type: 'boolean', default: false },
      'no-persist': { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      out: { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;
  const store = new FileConfigStore(SOURCES_DIR);
  const logger = createLogger({ app: 'crawler' });
  const int = (v?: string) => (v === undefined ? undefined : Number.parseInt(v, 10));
  // Same config, different host: crawl the mock dealer (or a staging mirror) without editing JSON.
  const rebase = (c: SourceConfig): SourceConfig => (values['base-url'] ? { ...c, baseUrl: values['base-url'] } : c);

  if (!command || values.help) {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case 'crawl': {
      if (!arg) throw new Error('crawl: missing <sourceId|all>');
      const configs = (
        arg === 'all'
          ? (await store.list()).flatMap((c) => (c.config?.enabled ? [c.config] : []))
          : [await store.get(arg)]
      ).map(rebase);
      // A rebased crawl must never write into the real source's history.
      const persist = !values['no-persist'] && !values['base-url'];
      const db = process.env.DATABASE_URL && persist ? createPool() : undefined;
      if (db) await migrate(db);
      let failed = 0;
      try {
        for (const config of configs) {
          try {
            const { summary, units } = await crawlSource(config, {
              outDir: values.out ?? OUTPUT_DIR,
              logger,
              maxPages: int(values['max-pages']),
              limit: int(values.limit),
              detail: !values['no-detail'],
            });
            printSummary(summary);
            if (db) printApply(await persistRun(db, config, summary, units));
          } catch (err) {
            // One dealer failing must never stop the others.
            failed++;
            logger.error('run.crashed', { sourceId: config.id, error: (err as Error).stack });
          }
        }
      } finally {
        await db?.end();
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }

    case 'import': {
      if (!arg) throw new Error('import: missing <runDir>');
      const db = createPool();
      try {
        await migrate(db);
        const run = await loadRunDir(path.resolve(arg));
        printApply(await persistRun(db, await store.get(run.summary.sourceId), run.summary, run.units));
      } finally {
        await db.end();
      }
      return;
    }

    case 'simulate': {
      // A simulated week on real inventory → DB → exports/ (the data-export deliverable).
      const runDir = arg ? path.resolve(arg) : await latestFullRun();
      const db = createPool();
      try {
        if (values.reset) await resetDatabase(db);
        else await migrate(db);
        const existing = await db.query('SELECT count(*)::int AS n FROM crawl_runs');
        if (existing.rows[0].n > 0) throw new Error('simulate needs an empty database (it writes a dated history) — re-run with --reset');
        const base = await loadRunDir(runDir);
        const config = await store.get(base.summary.sourceId);
        const crawled = new Date(base.summary.startedAt);
        // Seven nights at 02:00 UTC, ending on the night of the real crawl.
        const start = new Date(Date.UTC(crawled.getUTCFullYear(), crawled.getUTCMonth(), crawled.getUTCDate() - 6, 2));
        const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, 'exports'));
        const sim = await simulateWeek(db, config, base.units, { start, logger, outDir: path.join(OUTPUT_DIR, '.simulate') });
        for (const n of sim.nights) {
          process.stdout.write(`\nNight ${n.n}  ${n.at.slice(0, 10)}  ${n.label}${n.healthy ? '' : '  [UNHEALTHY]'}\n`);
          for (const m of n.scripted) process.stdout.write(`    - ${m}\n`);
          printApply(n.stats);
        }
        const counts = await exportDatabase(db, outDir, { rewrite: { from: sim.origin, to: new URL(config.baseUrl).origin } });
        await writeSimulationReadme(outDir, { base, nights: sim.nights, fidelity: sim.fidelity, counts });
        await mkdir(path.join(outDir, 'live-crawl'), { recursive: true });
        await copyFile(path.join(runDir, 'units.ndjson'), path.join(outDir, 'live-crawl', 'units.ndjson'));
        await copyFile(path.join(runDir, 'summary.json'), path.join(outDir, 'live-crawl', 'summary.json'));
        const byField: Record<string, number> = {};
        for (const m of sim.fidelity.mismatches) for (const f of m.fields) byField[f] = (byField[f] ?? 0) + 1;
        if (sim.fidelity.mismatches.length) process.stdout.write(`\nFidelity mismatches by field: ${JSON.stringify(byField)}\n`);
        process.stdout.write(
          `\nFidelity: ${sim.fidelity.matched}/${sim.fidelity.units} real units reproduced exactly by the mock site\n` +
            `Exported to ${path.relative(process.cwd(), outDir) || '.'}: ${Object.entries(counts).map(([f, n]) => `${f} (${n})`).join(', ')}\n`,
        );
      } finally {
        await db.end();
      }
      return;
    }

    case 'export': {
      const db = createPool();
      try {
        const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, 'exports'));
        const counts = await exportDatabase(db, outDir, { sourceId: arg });
        process.stdout.write(`Exported to ${outDir}: ${Object.entries(counts).map(([f, n]) => `${f} (${n})`).join(', ')}\n`);
      } finally {
        await db.end();
      }
      return;
    }

    case 'db:migrate':
    case 'db:reset': {
      const db = createPool();
      try {
        const applied = command === 'db:reset' ? await resetDatabase(db) : await migrate(db);
        process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Up to date.\n');
      } finally {
        await db.end();
      }
      return;
    }

    case 'probe': {
      if (!arg) throw new Error('probe: missing <sourceId>');
      const config = rebase(await store.get(arg));
      const http = new HttpClient({ ...config.http, logger });
      const driver = getDriver(config.driver);
      const ctx = { config, http, logger };
      const n = int(values.limit) ?? 1;
      for await (const page of driver.discover(ctx, { maxPages: 1 })) {
        const out = [];
        for (const stub of page.stubs.slice(0, n)) {
          const detail = config.detail?.enabled ? await driver.fetchDetail(ctx, stub) : undefined;
          out.push(normalizeUnit(config, stub, detail, new Date().toISOString()));
        }
        process.stdout.write(
          JSON.stringify({ pageUrl: page.pageUrl, siteTotal: page.siteTotal, items: page.stubs.length, results: out }, null, 2) + '\n',
        );
        break; // first start URL is enough for a probe
      }
      return;
    }

    case 'sources:list':
    case 'sources:validate': {
      const all = await store.list();
      let bad = 0;
      for (const c of all) {
        const name = path.relative(SOURCES_DIR, c.origin);
        if (c.config) {
          process.stdout.write(
            `✓ ${name}  id=${c.config.id} v${c.config.version} driver=${c.config.driver} enabled=${c.config.enabled}\n`,
          );
        } else {
          bad++;
          process.stdout.write(`✗ ${name}\n${c.errors.map((e) => `    ${e}`).join('\n')}\n`);
        }
      }
      if (command === 'sources:validate' && bad) process.exitCode = 1;
      return;
    }

    case 'fixtures:capture': {
      if (!arg) throw new Error('fixtures:capture: missing <sourceId>');
      await captureFixtures(await store.get(arg), logger);
      return;
    }

    default:
      process.stdout.write(`Unknown command "${command}"\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function captureFixtures(config: SourceConfig, logger: ReturnType<typeof createLogger>) {
  const dir = path.join(SOURCES_DIR, 'fixtures', config.id);
  await mkdir(dir, { recursive: true });
  const http = new HttpClient({ ...config.http, logger });

  const listUrl = new URL(config.list.startUrls[0]!, config.baseUrl).toString();
  const list = await http.get(listUrl);
  await writeFile(path.join(dir, 'list-page-1.html'), list.body);
  const stub = parseListPage(config, list.body, list.url).stubs[0];
  if (!stub) throw new Error('No units parsed from list page 1 — fix list.item / fields first (try `probe`).');

  const detailFile = `detail-${stub.key.replace(/[^\w-]/g, '_')}.html`;
  const detail = await http.get(stub.url);
  await writeFile(path.join(dir, detailFile), detail.body);

  const manifestPath = path.join(dir, 'manifest.json');
  const existing = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({}));
  const manifest = {
    ...existing,
    capturedAt: new Date().toISOString(),
    list: [{ file: 'list-page-1.html', url: list.url }],
    detail: [{ file: detailFile, url: detail.url }],
    expect: existing.expect ?? { minListItems: 1, listFields: ['listingUrl'], unitFields: ['listingUrl'] },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`Captured fixtures for ${config.id} → ${dir}\n`);
}

/** Most recent healthy, complete crawl under .output/ (the simulation's seed). */
async function latestFullRun(): Promise<string> {
  const candidates: Array<{ dir: string; startedAt: string }> = [];
  for (const source of await readdir(OUTPUT_DIR).catch(() => [] as string[])) {
    if (source.startsWith('.')) continue;
    for (const run of await readdir(path.join(OUTPUT_DIR, source)).catch(() => [] as string[])) {
      const dir = path.join(OUTPUT_DIR, source, run);
      try {
        const { summary } = await loadRunDir(dir);
        if (summary.health.healthy && !summary.partial) candidates.push({ dir, startedAt: summary.startedAt });
      } catch {
        /* not a run dir */
      }
    }
  }
  const latest = candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latest) throw new Error('no healthy full crawl under .output/ — run `pnpm crawl transwest` first, or pass <runDir>');
  return latest.dir;
}

function printApply(s: ApplyStats) {
  if (s.skipped) {
    process.stdout.write(`  db: skipped (${s.skipped})\n`);
    return;
  }
  const events = Object.entries(s.events).map(([k, v]) => `${k}=${v}`).join(' ') || 'no changes';
  process.stdout.write(
    `  db: ${s.staged} staged → ${events} | removal check ${s.removalCheck}` +
      (s.missedUnderGrace ? ` | ${s.missedUnderGrace} missing, within grace` : '') +
      '\n',
  );
}

function printSummary(s: Awaited<ReturnType<typeof crawlSource>>['summary']) {
  const c = s.counts;
  process.stdout.write(
    [
      ``,
      `Run ${s.runId}  (${(s.durationMs / 1000).toFixed(1)}s, ${s.http.requests} requests)`,
      `  site total: ${c.siteTotal ?? 'n/a'}  discovered: ${c.discovered}  valid: ${c.valid}  invalid: ${c.invalid}  detail failed: ${c.detailFailed}`,
      `  media: ${c.images} images, ${c.videos} videos, ${c.documents} documents`,
      `  availability: ${JSON.stringify(s.availability)}`,
      `  health: ${s.health.healthy ? 'HEALTHY' : 'UNHEALTHY'}${s.health.reasons.length ? ` — ${s.health.reasons.join('; ')}` : ''}`,
      `  output: ${s.outputDir}`,
      ``,
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
