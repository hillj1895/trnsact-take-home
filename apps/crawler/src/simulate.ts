import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, detailsFacet, facetHashes, type Logger, type SourceConfig, type Unit } from '@trnsact/core';
import type { ApplyStats, Pool } from '@trnsact/db';
import { MockDealer, mockUnitFromUnit, priceText, type MockUnit } from '@trnsact/testkit';
import { persistRun } from './persist.js';
import { crawlSource } from './run.js';

/**
 * A simulated week on REAL inventory.
 *
 * The mock dealer site is seeded with every unit from a real crawl (same paths,
 * ids, specs, photo asset ids; only the host differs). Each night it is
 * changed by a script and crawled through the full production pipeline:
 * HTTP → extract → normalize → persist → applyRun. That's how we get change
 * history without waiting a week, and it powers the data-export deliverable.
 */
export interface SimulatedNight {
  n: number;
  at: string;
  label: string;
  runId: string;
  healthy: boolean;
  healthReasons: string[];
  discovered: number;
  detailFailed: number;
  scripted: string[];
  stats: ApplyStats;
}

export interface Fidelity {
  units: number;
  matched: number;
  /** Units whose facet hashes (details / price / media) or availability differ between real and mock crawl. */
  mismatches: Array<{ key: string; facets: string[]; fields: string[] }>;
}

type Script = (site: MockDealer, pick: Picker) => string[];
type Picker = (pred: (u: MockUnit) => boolean, count: number) => MockUnit[];

const usd = (n: number | null) => (n === null ? 'Contact For Price' : `$${n.toLocaleString('en-US')}`);
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const available = (u: MockUnit) => u.status === 'Available' && !u.isSold;
const priced = (u: MockUnit) => available(u) && u.price !== null;
// Edits re-render the card from current data (the stale card price text, e.g. "Sold", is cleared).
const setStatus = (u: MockUnit, status: string) => Object.assign(u, { status, isSold: status === 'Sold', cardPriceText: undefined });
const setPrice = (u: MockUnit, price: number | null) => Object.assign(u, { price, cardPriceText: undefined });
const stockList = (us: MockUnit[]) => us.map((u) => u.stockNumber).join(', ');

/** The week. Each night's script runs against the site before that night's crawl. */
function weekScript(used: Set<string>): Array<{ label: string; script: Script }> {
  const removed: MockUnit[] = [];
  const newUnit = (template: MockUnit, n: number): MockUnit => ({
    ...structuredClone(template),
    id: 9_000_000 + n,
    stockNumber: `SIM${String(n).padStart(4, '0')}`,
    vin: `SIMVIN${String(n).padStart(11, '0')}`,
    path: undefined, // generated, Transwest-style
    status: 'Available',
    isSold: false,
  });

  return [
    { label: 'Baseline: real Transwest inventory', script: () => [] },
    {
      label: 'Price cuts, two deals go pending, one new arrival',
      script: (site, pick) => {
        const log: string[] = [];
        for (const u of pick(priced, 4)) {
          const cut = roundTo(u.price! * 0.95, 100);
          log.push(`price cut ${u.stockNumber}: ${usd(u.price)} → ${usd(cut)}`);
          setPrice(u, cut);
        }
        for (const u of pick(available, 2)) {
          log.push(`sale pending ${u.stockNumber}`);
          setStatus(u, 'Sale Pending');
        }
        const [template] = pick(priced, 1);
        const fresh = newUnit(template!, 1);
        site.add(fresh, 'top');
        log.push(`new listing ${fresh.stockNumber} (${fresh.title ?? ''})`);
        return log;
      },
    },
    {
      label: 'Sales close, photo edits, mileage update, three units taken down',
      script: (site, pick) => {
        const log: string[] = [];
        const pending = site.inventory.find((u) => u.status === 'Sale Pending' && used.has(u.stockNumber));
        if (pending) {
          setStatus(pending, 'Sold');
          log.push(`sold ${pending.stockNumber} (was Sale Pending)`);
        }
        for (const u of pick(available, 1)) {
          setStatus(u, 'Sold');
          log.push(`sold ${u.stockNumber} (straight from Available)`);
        }
        for (const u of pick(priced, 1)) {
          log.push(`price hidden ${u.stockNumber}: ${usd(u.price)} → Contact For Price`);
          setPrice(u, null);
        }
        for (const u of pick((x) => available(x) && x.mileage !== undefined && x.condition === 'Used', 1)) {
          log.push(`mileage ${u.stockNumber}: ${u.mileage} → ${u.mileage! + 238} (demo drive)`);
          u.mileage = u.mileage! + 238;
        }
        for (const u of pick((x) => x.images.length > 3, 1)) {
          u.images.pop();
          log.push(`photo removed ${u.stockNumber}`);
        }
        for (const u of pick((x) => x.images.length > 3, 1)) {
          u.images.push(u.images.shift()!);
          log.push(`photos reordered ${u.stockNumber} (cover photo moved to the end)`);
        }
        for (const u of pick(available, 3)) {
          removed.push(site.remove(u.stockNumber));
        }
        log.push(`taken down: ${stockList(removed)} (1st missed run)`);
        return log;
      },
    },
    {
      label: 'Flaky night: detail pages down and transient errors (still healthy)',
      script: (site, pick) => {
        const log: string[] = [];
        const down = pick(priced, 4);
        for (const u of down) site.failDetail(u.stockNumber);
        log.push(`detail pages returning 500 all night: ${stockList(down)}`);
        const cut = roundTo(down[0]!.price! * 0.9, 100);
        log.push(`…and ${down[0]!.stockNumber} is cut ${usd(down[0]!.price)} → ${usd(cut)} (visible on the list card)`);
        setPrice(down[0]!, cut);
        site.failListPage(2, { status: 429, times: 1 });
        log.push('list page 2: one 429 (retried)');
        log.push(`${stockList(removed)} miss a 2nd healthy run → removal`);
        return log;
      },
    },
    {
      label: 'Broken scrape: truck list page 3 fails all night (unhealthy)',
      script: (site, pick) => {
        site.failListPage(3, { status: 500 });
        const firstPage = site.inventory.filter((u) => u.group === 'trucks').slice(0, site.pageSize);
        const [u] = pick((x) => priced(x) && firstPage.includes(x), 1);
        const cut = roundTo(u!.price! * 0.97, 100);
        const log = [
          'trucks ?page=3 returns 500 all night → run unhealthy, removal check skipped',
          `price cut on page 1 still recorded: ${u!.stockNumber} ${usd(u!.price)} → ${usd(cut)}`,
        ];
        setPrice(u!, cut);
        return log;
      },
    },
    {
      label: 'Recovery: a relist, a price revealed, two new arrivals, a spec correction',
      script: (site, pick) => {
        const log: string[] = [];
        const back = removed.shift()!;
        site.add(back, 'top');
        log.push(`relisted ${back.stockNumber}`);
        for (const u of pick((x) => available(x) && x.price === null, 1)) {
          setPrice(u, 74_900);
          log.push(`price revealed ${u.stockNumber}: Contact For Price → ${usd(u.price)}`);
        }
        const templates = pick(priced, 2);
        templates.forEach((t, i) => {
          const fresh = newUnit(t, 2 + i);
          site.add(fresh, 'top');
          log.push(`new listing ${fresh.stockNumber}`);
        });
        for (const u of pick((x) => 'Exterior Color' in x.specs, 1)) {
          log.push(`spec correction ${u.stockNumber}: Exterior Color ${u.specs['Exterior Color']} → Red`);
          u.specs['Exterior Color'] = 'Red';
        }
        return log;
      },
    },
    {
      label: 'Coming-soon units arrive priced, a sold unit is taken down, a price increase',
      script: (site, pick) => {
        const log: string[] = [];
        for (const [i, u] of pick((x) => x.status === 'Coming Soon', 2).entries()) {
          const was = priceText(u);
          setStatus(u, 'Available');
          setPrice(u, 129_900 + i * 2_500);
          log.push(`arrived ${u.stockNumber}: Coming Soon → Available, priced ${was} → ${usd(u.price)}`);
        }
        for (const u of pick((x) => x.isSold === true, 1)) {
          site.remove(u.stockNumber);
          log.push(`sold unit taken down ${u.stockNumber} (1st missed run)`);
        }
        for (const u of pick(priced, 1)) {
          const up = roundTo(u.price! * 1.04, 100);
          log.push(`price increase ${u.stockNumber}: ${usd(u.price)} → ${usd(up)}`);
          setPrice(u, up);
        }
        return log;
      },
    },
  ];
}

export async function simulateWeek(
  db: Pool,
  baseConfig: SourceConfig,
  realUnits: Unit[],
  opts: { start: Date; logger: Logger; outDir: string },
): Promise<{ nights: SimulatedNight[]; origin: string; fidelity: Fidelity }> {
  const site = await new MockDealer({ inventory: realUnits.map(mockUnitFromUnit), pageSize: 19 }).start();
  const config: SourceConfig = structuredClone({ ...baseConfig, baseUrl: site.url });
  config.http = { ...config.http, requestsPerSecond: 500, concurrency: 4, retries: 2 }; // localhost

  // Deterministic picks: by stock number, each unit used by at most one scripted change.
  const used = new Set<string>();
  const pick: Picker = (pred, count) => {
    const out = [...site.inventory]
      .sort((a, b) => a.stockNumber.localeCompare(b.stockNumber))
      .filter((u) => !used.has(u.stockNumber) && pred(u))
      .slice(0, count);
    out.forEach((u) => used.add(u.stockNumber));
    return out;
  };

  const nights: SimulatedNight[] = [];
  let fidelity: Fidelity | undefined;
  try {
    for (const [n, { label, script }] of weekScript(used).entries()) {
      if (n > 0) site.nextNight();
      site.clearFaults();
      const scripted = script(site, pick);
      const at = new Date(opts.start.getTime() + n * 24 * 3600 * 1000);
      const wall = Date.now();
      const { summary, units } = await crawlSource(config, {
        outDir: opts.outDir,
        logger: opts.logger,
        now: () => new Date(at.getTime() + (Date.now() - wall)),
      });
      if (n === 0) fidelity = compare(realUnits, units, site.url, baseConfig);
      const stats = await persistRun(db, config, summary, units);
      nights.push({
        n,
        at: at.toISOString(),
        label,
        runId: summary.runId,
        healthy: summary.health.healthy,
        healthReasons: summary.health.reasons,
        discovered: summary.counts.discovered,
        detailFailed: summary.counts.detailFailed,
        scripted,
        stats,
      });
      opts.logger.info('simulate.night', { n, label, healthy: summary.health.healthy, events: stats.events });
    }
  } finally {
    await site.close();
  }
  return { nights, origin: site.url, fidelity: fidelity! };
}

/** Night 0 sanity check: does crawling the mock reproduce the real crawl, unit for unit? */
function compare(real: Unit[], mock: Unit[], mockOrigin: string, config: SourceConfig): Fidelity {
  const realOrigin = new URL(config.baseUrl).origin;
  const ignoreSpecs = config.detail?.hashIgnoreSpecs ?? [];
  const byKey = new Map(mock.map((u) => [u.sourceUnitKey, JSON.parse(JSON.stringify(u).replaceAll(mockOrigin, realOrigin)) as Unit]));
  const mismatches: Fidelity['mismatches'] = [];
  for (const r of real) {
    const m = byKey.get(r.sourceUnitKey);
    if (!m) {
      mismatches.push({ key: r.sourceUnitKey, facets: ['missing'], fields: [] });
      continue;
    }
    const a = facetHashes(r, { ignoreSpecs });
    const b = facetHashes(m, { ignoreSpecs });
    const facets = (['details', 'price', 'media'] as const).filter((f) => !a[f].equals(b[f]));
    if (r.availability !== m.availability) facets.push('availability' as never);
    if (facets.length) mismatches.push({ key: r.sourceUnitKey, facets, fields: diffFields(r, m, ignoreSpecs) });
  }
  return { units: real.length, matched: real.length - mismatches.length, mismatches };
}

function diffFields(a: Unit, b: Unit, ignoreSpecs: string[]): string[] {
  const flat = (u: Unit) => {
    const { specs, ...rest } = detailsFacet(u, { ignoreSpecs });
    return {
      ...rest,
      ...Object.fromEntries(Object.entries(specs).map(([k, v]) => [`spec:${k}`, v])),
      price: u.price,
      availability: u.availability,
      media: u.media.map((m) => m.key),
    } as Record<string, unknown>;
  };
  const fa = flat(a);
  const fb = flat(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => canonicalJson(fa[k]) !== canonicalJson(fb[k]));
}

const FILES: Record<string, string> = {
  'units.csv': 'Current state of every unit ever seen (one row per unit, incl. removed)',
  'units_full.ndjson': 'Same, with the full normalized record (specs, media, warnings)',
  'events.csv': 'Change log: NEW / PRICE_CHANGED / AVAILABILITY_CHANGED / DETAILS_CHANGED / MEDIA_CHANGED / REMOVED / RELISTED',
  'events.ndjson': 'Same, with `changes` as nested JSON',
  'price_history.csv': 'Price per unit as time ranges [valid_from, valid_to); open range = current',
  'availability_history.csv': 'Availability per unit as time ranges',
  'media.csv': 'Every photo per unit, incl. removed ones (removed_at)',
  'runs.csv': 'One row per nightly run: health, counts, events produced, whether removal ran',
};

export async function writeSimulationReadme(
  outDir: string,
  d: { base: { summary: { runId: string; startedAt: string }; units: Unit[] }; nights: SimulatedNight[]; fidelity: Fidelity; counts: Record<string, number> },
): Promise<void> {
  const fmtEvents = (e: Record<string, number>) => Object.entries(e).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
  const md = `# Data export

Generated by \`pnpm simulate --reset\`. Regenerate any time: for a given seed crawl the events and history are deterministic (only run durations vary).

## What this is

* **Inventory is real.** All ${d.base.units.length} units come from a live crawl of transwest.com
  (\`${d.base.summary.runId}\`, raw output in [\`live-crawl/\`](live-crawl/)).
* **The week of changes is simulated.** One crawl can't show change history, so the mock dealer site
  (\`packages/testkit\`) was seeded with that real inventory and changed by a script each night. Each
  night was crawled through the full production pipeline (HTTP → extract → normalize → persist →
  change detection) into Postgres, then exported. Nothing below was written to the DB directly.
* **Fidelity check:** crawling the mock on night 0 reproduced **${d.fidelity.matched} / ${d.fidelity.units}**
  real units exactly (same details, price and media hashes, same availability).${
    d.fidelity.mismatches.length
      ? ` Differences: ${d.fidelity.mismatches.slice(0, 10).map((m) => `${m.key} (${m.facets.join('/')})`).join(', ')}.`
      : ''
  }
* The mock served the real URL paths on localhost; the host was swapped back to
  \`https://www.transwest.com\` on export. \`SIM0001\`–\`SIM0003\` are synthetic "new arrivals" cloned from
  real units. Timestamps are simulated nights at 02:00 UTC.

## The week

| Night | Date | What happened | Run | Events |
|---|---|---|---|---|
${d.nights
  .map(
    (n) =>
      `| ${n.n} | ${n.at.slice(0, 10)} | ${n.label} | ${n.healthy ? 'healthy' : `**unhealthy**: ${n.healthReasons.join('; ')}`}${n.detailFailed ? `, ${n.detailFailed} detail pages failed` : ''} | ${fmtEvents(n.stats.events)}${n.stats.missedUnderGrace ? ` (${n.stats.missedUnderGrace} missing, within grace)` : ''}${n.stats.removalCheck.startsWith('skipped') ? ' · removal check skipped' : ''} |`,
  )
  .join('\n')}

### Scripted changes per night

${d.nights
  .filter((n) => n.scripted.length)
  .map((n) => `**Night ${n.n}: ${n.label}**\n${n.scripted.map((s) => `- ${s}`).join('\n')}`)
  .join('\n\n')}

## Files

| File | Rows | Contents |
|---|---|---|
${Object.entries(d.counts)
  .map(([f, rows]) => `| [\`${f}\`](${f}) | ${rows} | ${FILES[f] ?? ''} |`)
  .join('\n')}
| [\`live-crawl/\`](live-crawl/) | ${d.base.units.length} | Raw output of the real crawl (\`units.ndjson\`, \`summary.json\`) |
| [\`real-crawl-pair/\`](real-crawl-pair/) | | **Real** change data: two live crawls 4.5 h apart, imported and diffed (no simulation) |

Schema: [\`packages/db/migrations/\`](../packages/db/migrations/).
`;
  await writeFile(path.join(outDir, 'README.md'), md);
}
