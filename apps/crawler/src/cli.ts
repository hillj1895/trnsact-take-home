import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, type SourceConfig } from '@trnsact/core';
import { getDriver, normalizeUnit, parseListPage } from '@trnsact/extract';
import { HttpClient } from '@trnsact/http';
import { FileConfigStore } from './config-store.js';
import { OUTPUT_DIR, SOURCES_DIR } from './paths.js';
import { crawlSource } from './run.js';

const USAGE = `
Usage: pnpm <script> [args]

  crawl <sourceId|all> [--max-pages N] [--limit N] [--no-detail] [--out DIR]
      Run a full crawl for one source (or every enabled source).

  probe <sourceId> [--limit N]
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
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;
  const store = new FileConfigStore(SOURCES_DIR);
  const logger = createLogger({ app: 'crawler' });
  const int = (v?: string) => (v === undefined ? undefined : Number.parseInt(v, 10));

  if (!command || values.help) {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case 'crawl': {
      if (!arg) throw new Error('crawl: missing <sourceId|all>');
      const configs =
        arg === 'all'
          ? (await store.list()).flatMap((c) => (c.config?.enabled ? [c.config] : []))
          : [await store.get(arg)];
      let failed = 0;
      for (const config of configs) {
        try {
          const summary = await crawlSource(config, {
            outDir: values.out ?? OUTPUT_DIR,
            logger,
            maxPages: int(values['max-pages']),
            limit: int(values.limit),
            detail: !values['no-detail'],
          });
          printSummary(summary);
        } catch (err) {
          // One dealer failing must never stop the others.
          failed++;
          logger.error('run.crashed', { sourceId: config.id, error: (err as Error).stack });
        }
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }

    case 'probe': {
      if (!arg) throw new Error('probe: missing <sourceId>');
      const config = await store.get(arg);
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

function printSummary(s: Awaited<ReturnType<typeof crawlSource>>) {
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
