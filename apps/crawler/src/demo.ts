import type { SourceConfig, Unit } from '@trnsact/core';
import type { ApplyStats, Pool } from '@trnsact/db';
import { persistRun } from './persist.js';
import type { RunSummary } from './summary.js';

/**
 * Change-detection demo without waiting for real nights to pass.
 *
 * Takes a REAL crawl as night 0, then replays it as further "nights" with
 * scripted, clearly-labelled mutations. Every night goes through the exact
 * same persistRun → applyRun path as a live crawl.
 *
 *   night 1  healthy  price cuts, hidden price, pending/sold, mileage + spec edits,
 *                     photo added/removed, 3 units vanish, 1 new unit appears
 *   night 2  BROKEN   scrape returns only 10 units, run is unhealthy → nothing removed
 *   night 3  healthy  the 3 vanished units miss a 2nd healthy run → REMOVED
 *   night 4  healthy  one removed unit is reposted → RELISTED
 */
export interface DemoNight {
  label: string;
  runId: string;
  stats: ApplyStats;
  mutations: string[];
}

export async function runChangeDemo(
  db: Pool,
  config: SourceConfig,
  base: { summary: RunSummary; units: Unit[] },
): Promise<DemoNight[]> {
  const nights: DemoNight[] = [];
  const baseTime = new Date(base.summary.startedAt).getTime();
  const DAY = 24 * 3600 * 1000;

  const night = async (n: number, label: string, units: Unit[], healthy: boolean, mutations: string[]) => {
    const startedAt = new Date(baseTime + n * DAY);
    const runId = `${base.summary.runId}-demo-night-${n}`;
    const summary: RunSummary = {
      ...base.summary,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + base.summary.durationMs).toISOString(),
      partial: false,
      counts: { ...base.summary.counts, discovered: units.length, valid: units.length, processed: units.length },
      health: healthy
        ? { ...base.summary.health, healthy: true, reasons: [] }
        : { ...base.summary.health, healthy: false, coverage: units.length / base.units.length, reasons: ['coverage below 0.95 (simulated broken scrape)'] },
    };
    const stamped = units.map((u) => ({ ...u, scrapedAt: startedAt.toISOString() }));
    nights.push({ label, runId, stats: await persistRun(db, config, summary, stamped), mutations });
  };

  // Night 0: the real crawl, as-is.
  await persistRun(db, config, base.summary, base.units);

  // Night 1: scripted changes, deterministic picks.
  const units = structuredClone(base.units).sort((a, b) => a.sourceUnitKey.localeCompare(b.sourceUnitKey));
  const used = new Set<string>();
  const log: string[] = [];
  const pick = (pred: (u: Unit) => boolean, count: number) => {
    const out = units.filter((u) => !used.has(u.sourceUnitKey) && pred(u)).slice(0, count);
    out.forEach((u) => used.add(u.sourceUnitKey));
    return out;
  };
  const priced = (u: Unit) => u.availability === 'available' && u.price.amount !== null;
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
  const setPrice = (u: Unit, amount: number | null, text: string) => {
    u.price = { ...u.price, amount, text };
    if ('List Price' in u.specs) u.specs['List Price'] = text;
  };
  const setStatus = (u: Unit, availability: Unit['availability'], raw: string) => {
    u.availability = availability;
    u.availabilityRaw = raw;
    if ('Status' in u.specs) u.specs.Status = raw;
  };

  for (const u of pick(priced, 3)) {
    const cut = Math.round((u.price.amount! * 0.95) / 100) * 100;
    log.push(`price cut ${u.stockNumber}: ${u.price.text} → ${usd(cut)}`);
    setPrice(u, cut, usd(cut));
  }
  for (const u of pick(priced, 1)) {
    log.push(`price hidden ${u.stockNumber}: ${u.price.text} → Contact For Price`);
    setPrice(u, null, 'Contact For Price');
  }
  for (const u of pick((x) => x.availability === 'available', 2)) {
    log.push(`pending ${u.stockNumber}: ${u.availabilityRaw} → Sale Pending`);
    setStatus(u, 'pending', 'Sale Pending');
  }
  for (const u of pick((x) => x.availability === 'available', 1)) {
    log.push(`sold ${u.stockNumber}: ${u.availabilityRaw} → Sold`);
    setStatus(u, 'sold', 'Sold');
  }
  for (const u of pick((x) => x.mileage !== undefined, 1)) {
    const miles = u.mileage! + 412;
    log.push(`mileage ${u.stockNumber}: ${u.mileage} → ${miles}`);
    u.mileage = miles;
    if ('Mileage' in u.specs) u.specs.Mileage = miles.toLocaleString('en-US');
  }
  for (const u of pick((x) => 'Exterior Color' in x.specs, 1)) {
    log.push(`spec edit ${u.stockNumber}: Exterior Color ${u.specs['Exterior Color']} → Red`);
    u.specs['Exterior Color'] = 'Red';
  }
  for (const u of pick((x) => x.media.some((m) => m.kind === 'image'), 1)) {
    const url = `${new URL(u.listingUrl).origin}/img/secure/inventory/images/demo-added-photo.webp`;
    u.media.push({ kind: 'image', url, key: `image:${url}`, position: u.media.length });
    log.push(`photo added ${u.stockNumber}`);
  }
  for (const u of pick((x) => x.media.length > 1, 1)) {
    u.media.pop();
    log.push(`photo removed ${u.stockNumber}`);
  }
  const vanished = pick(() => true, 3);
  log.push(`vanished from site: ${vanished.map((u) => u.stockNumber).join(', ')}`);

  const template = units.find((u) => !used.has(u.sourceUnitKey))!;
  const fresh: Unit = {
    ...structuredClone(template),
    sourceUnitKey: 'demo-new-1',
    platformId: 'demo-new-1',
    stockNumber: 'DEMO-NEW-1',
    vin: undefined,
    listingUrl: `${new URL(template.listingUrl).origin}/trucks/demo-new-unit/`,
    title: `${template.title} (demo new unit)`,
  };
  log.push(`new listing ${fresh.stockNumber}`);

  const gone = new Set(vanished.map((u) => u.sourceUnitKey));
  const night1 = [...units.filter((u) => !gone.has(u.sourceUnitKey)), fresh];
  await night(1, 'healthy run with scripted changes', night1, true, log);

  // Night 2: broken scrape — only 10 units come back, run flagged unhealthy.
  await night(2, 'BROKEN scrape (unhealthy, 10 units)', night1.slice(0, 10), false, [
    `simulated broken scrape: ${night1.length - 10} units missing, run unhealthy → removal check skipped`,
  ]);

  // Night 3: same as night 1 — vanished units miss their 2nd healthy run.
  await night(3, 'healthy, vanished units miss a 2nd run', night1, true, ['no new changes; grace period expires']);

  // Night 4: one vanished unit is reposted.
  const back = base.units.find((u) => u.sourceUnitKey === vanished[0]!.sourceUnitKey)!;
  await night(4, 'one removed unit reposted', [...night1, back], true, [`relisted ${back.stockNumber}`]);

  return nights;
}
