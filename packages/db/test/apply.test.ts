import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { facetHashes, SourceConfig, type Unit } from '@trnsact/core';
import { applyRun, createPool, recordRun, resetDatabase, stageUnits, upsertSource, type Pool } from '../src/index.js';

/**
 * Integration test against a real Postgres. Destructive (drops the public schema),
 * so it only runs when TEST_DATABASE_URL is set explicitly.
 */
const url = process.env.TEST_DATABASE_URL;

const config = SourceConfig.parse({
  id: 'test-dealer',
  version: 1,
  dealer: { id: 'test-dealer', name: 'Test Dealer' },
  driver: 'html',
  baseUrl: 'https://dealer.test',
  list: { startUrls: ['/'], pagination: { type: 'none' }, item: 'li', fields: { listingUrl: { attr: 'href' } } },
  detail: { hashIgnoreSpecs: ['List Price'] },
  identity: ['stockNumber'],
});

const unit = (key: string, over: Partial<Unit> = {}): Unit => ({
  sourceId: config.id,
  dealerId: config.dealer.id,
  sourceUnitKey: key,
  listingUrl: `https://dealer.test/u/${key}`,
  stockNumber: key,
  year: 2020,
  make: 'Kenworth',
  model: 'T880',
  condition: 'used',
  mileage: 100_000,
  price: { amount: 100_000, msrp: null, currency: 'USD', text: '$100,000' },
  availability: 'available',
  availabilityRaw: 'Available',
  specs: { 'Engine Make': 'PACCAR', 'List Price': '$100,000' },
  media: [{ kind: 'image', url: `https://dealer.test/i/${key}-1.jpg?s=1`, key: `image:https://dealer.test/i/${key}-1.jpg`, position: 0 }],
  scrapedAt: new Date().toISOString(),
  warnings: [],
  ...over,
});

let pool: Pool;
let n = 0;
async function run(units: Unit[], opts: { healthy?: boolean } = {}) {
  const id = `run-${++n}`;
  await recordRun(pool, {
    id,
    sourceId: config.id,
    configVersion: 1,
    status: 'succeeded',
    healthy: opts.healthy ?? true,
    partial: false,
    startedAt: new Date(Date.UTC(2026, 0, n)).toISOString(), // one "night" apart
  });
  await stageUnits(pool, id, units.map((u) => ({ unit: u, hashes: facetHashes(u, { ignoreSpecs: config.detail!.hashIgnoreSpecs }) })));
  return applyRun(pool, id);
}
const events = async (runId: string) =>
  (await pool.query(`SELECT u.source_unit_key AS key, e.type, e.changes FROM unit_events e JOIN units u ON u.id = e.unit_id WHERE run_id = $1 ORDER BY key, type`, [runId])).rows;

describe.skipIf(!url)('applyRun (Postgres)', () => {
  beforeAll(async () => {
    pool = createPool(url);
    await resetDatabase(pool);
    await upsertSource(pool, config);
  });
  afterAll(async () => pool?.end());

  const A = unit('A');
  const B = unit('B');
  const C = unit('C');

  // Night-3 state, reused by later nights so they don't re-trigger changes.
  const A2: Unit = { ...A, price: { ...A.price, amount: 95_000, text: '$95,000' }, specs: { ...A.specs, 'List Price': '$95,000' } };
  const B2: Unit = {
    ...B,
    availability: 'pending',
    availabilityRaw: 'Sale Pending',
    specs: { ...B.specs, 'Engine Make': 'Cummins' },
    media: [...B.media, { kind: 'image', url: 'https://dealer.test/i/B-2.jpg', key: 'image:https://dealer.test/i/B-2.jpg', position: 1 }],
  };

  it('night 1: everything is NEW', async () => {
    const s = await run([A, B, C]);
    expect(s.events).toEqual({ NEW: 3 });
  });

  it('night 2: an identical crawl produces no events (scrape noise ignored)', async () => {
    const noisy = (u: Unit) => ({ ...u, scrapedAt: new Date().toISOString(), warnings: ['x'], media: u.media.map((m) => ({ ...m, url: m.url + 'rotated' })) });
    const s = await run([noisy(A), noisy(B), noisy(C)]);
    expect(s.events).toEqual({});
  });

  it('night 3: price cut, pending, spec + photo change; C missing (1st miss)', async () => {
    const s = await run([A2, B2]);
    expect(s.events).toEqual({ AVAILABILITY_CHANGED: 1, DETAILS_CHANGED: 1, MEDIA_CHANGED: 1, PRICE_CHANGED: 1 });
    expect(s.missedUnderGrace).toBe(1);

    const ev = await events(s.runId);
    expect(ev.find((e) => e.type === 'PRICE_CHANGED')).toMatchObject({ key: 'A', changes: { amount: { old: 100000, new: 95000 } } });
    // Ignored spec ("List Price") moved with the price but did NOT fire DETAILS_CHANGED for A:
    expect(ev.filter((e) => e.key === 'A').map((e) => e.type)).toEqual(['PRICE_CHANGED']);
    expect(ev.find((e) => e.type === 'DETAILS_CHANGED')!.changes).toEqual({ 'spec:Engine Make': { old: 'PACCAR', new: 'Cummins' } });
    expect(ev.find((e) => e.type === 'MEDIA_CHANGED')!.changes.added).toEqual(['image:https://dealer.test/i/B-2.jpg']);

    // Point-in-time price history
    const hist = await pool.query(
      `SELECT amount FROM unit_price_history h JOIN units u ON u.id = h.unit_id
       WHERE u.source_unit_key = 'A' AND h.valid @> $1::timestamptz`,
      [new Date(Date.UTC(2026, 0, 2, 12)).toISOString()],
    );
    expect(hist.rows).toEqual([{ amount: 100000 }]);
  });

  it('night 4: an UNHEALTHY run never removes anything', async () => {
    const s = await run([A2], { healthy: false });
    expect(s.removalCheck).toMatch(/skipped/);
    const removed = await pool.query(`SELECT count(*)::int AS n FROM units WHERE status = 'removed'`);
    expect(removed.rows[0].n).toBe(0);
  });

  it('night 5: C missing for a 2nd healthy run → REMOVED (grace = 2)', async () => {
    const s = await run([A2, B2]);
    expect(s.events).toEqual({ REMOVED: 1 });
    const ev = await events(s.runId);
    expect(ev[0]).toMatchObject({ key: 'C', type: 'REMOVED', changes: { lastAvailability: 'available', missedRuns: 2 } });
    const open = await pool.query(
      `SELECT count(*)::int AS n FROM unit_price_history h JOIN units u ON u.id = h.unit_id WHERE u.source_unit_key = 'C' AND upper_inf(h.valid)`,
    );
    expect(open.rows[0].n).toBe(0);
  });

  it('night 6: C comes back → RELISTED with fresh open ranges', async () => {
    const s = await run([C]);
    expect(s.events).toEqual({ RELISTED: 1 });
    const open = await pool.query(
      `SELECT count(*)::int AS n FROM unit_price_history h JOIN units u ON u.id = h.unit_id WHERE u.source_unit_key = 'C' AND upper_inf(h.valid)`,
    );
    expect(open.rows[0].n).toBe(1);
  });

  it('re-applying a run is a no-op', async () => {
    const s = await applyRun(pool, `run-${n}`);
    expect(s.skipped).toBe('already applied');
  });
});
