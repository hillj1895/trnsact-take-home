import { expect } from 'vitest';
import { mockUnit } from '@trnsact/testkit';
import { describeScenarios, Scenario } from './harness.js';

/**
 * "The dealer changed something overnight" — one scenario per kind of change.
 * Seed inventory: 25 trucks (MK0000–MK0024, 10 per page → 3 pages) + 3 trailers.
 * Every 4th unit (MK0003, MK0007, …) is "Contact For Price"; MK0001 lists at $61,000.
 */
describeScenarios('inventory changes (mock dealer → crawl → apply)', (scenario) => {
  scenario('first crawl: every unit is NEW and the run is healthy', async (s) => {
    const night = await s.night();
    expect(night.summary.health).toMatchObject({ healthy: true, coverage: 1 });
    expect(night.stats.events).toEqual({ NEW: 28 });

    // Extraction went through the real config: spec table beats the JSON-LD condition bug,
    // the full VIN comes from card data, and media has the 3 photos.
    const u = await s.unit('MK0001');
    expect(u).toMatchObject({ condition: 'used', vin: s.site.unit('MK0001').vin, price_amount: 61000, availability: 'available' });
    expect(u.data.media).toHaveLength(3);
  });

  scenario('identical re-crawl: no events, even though every image URL was re-signed', async (s) => {
    await s.night();
    const second = await s.night();
    expect(second.events).toEqual([]);
    expect(second.summary.health.healthy).toBe(true);
    // The signatures really did rotate (night 0 served s=sig0…), and current state holds the fresh URLs.
    expect((await s.unit('MK0001')).data.media[0].url).toMatch(/\?s=sig1/);
  });

  scenario('price cut → PRICE_CHANGED only (the "List Price" spec row does not leak into DETAILS)', async (s) => {
    const before = await s.night();
    s.site.update('MK0001', { price: 58_000 });
    const after = await s.night();

    expect(after.types).toEqual({ MK0001: ['PRICE_CHANGED'] });
    expect(after.events[0]!.changes).toMatchObject({ amount: { old: 61000, new: 58000 }, text: { old: '$61,000', new: '$58,000' } });
    expect(await s.priceAt('MK0001', Scenario.between(before, after))).toBe(61000);
    expect(await s.priceAt('MK0001', new Date(after.at.getTime() + 1000))).toBe(58000);
  });

  scenario('price hidden then revealed: "Contact For Price" is a null amount, not a $0 price', async (s) => {
    await s.night();
    s.site.update('MK0002', { price: null });
    const hidden = await s.night();
    expect(hidden.types).toEqual({ MK0002: ['PRICE_CHANGED'] });
    expect(hidden.events[0]!.changes).toMatchObject({ amount: { old: 62000, new: null }, text: { new: 'Contact For Price' } });

    s.site.update('MK0002', { price: 59_500 });
    const revealed = await s.night();
    expect(revealed.events[0]!.changes).toMatchObject({ amount: { old: null, new: 59500 } });
  });

  scenario('available → sale pending → sold: AVAILABILITY_CHANGED each night, with history', async (s) => {
    await s.night();
    s.site.update('MK0004', { status: 'Sale Pending' });
    const pending = await s.night();
    expect(pending.types).toEqual({ MK0004: ['AVAILABILITY_CHANGED'] });
    expect(pending.events[0]!.changes.availability).toEqual({ old: 'available', new: 'pending' });

    s.site.update('MK0004', { status: 'Sold' });
    const sold = await s.night();
    expect(sold.events[0]!.changes.availability).toEqual({ old: 'pending', new: 'sold' });

    const history = await s.db.query(
      `SELECT h.availability, upper_inf(h.valid) AS open FROM unit_availability_history h
       JOIN units u ON u.id = h.unit_id WHERE u.source_id = $1 AND u.stock_number = 'MK0004' ORDER BY lower(h.valid)`,
      [s.sourceId],
    );
    expect(history.rows).toEqual([
      { availability: 'available', open: false },
      { availability: 'pending', open: false },
      { availability: 'sold', open: true },
    ]);
  });

  scenario('spec edit + mileage creep → one DETAILS_CHANGED with a field-level diff', async (s) => {
    await s.night();
    const { mileage, specs } = s.site.unit('MK0005');
    s.site.update('MK0005', { mileage: mileage! + 412, specs: { ...specs, 'Exterior Color': 'Red' } });
    const night = await s.night();

    expect(night.types).toEqual({ MK0005: ['DETAILS_CHANGED'] });
    expect(night.events[0]!.changes).toMatchObject({
      mileage: { old: mileage, new: mileage! + 412 },
      'spec:Exterior Color': { old: specs['Exterior Color'], new: 'Red' },
    });
  });

  scenario('photos added, removed and reordered → MEDIA_CHANGED with added/removed keys', async (s) => {
    await s.night();
    s.site.unit('MK0006').images.push('u6p4');
    s.site.unit('MK0008').images.pop();
    s.site.unit('MK0009').images.reverse();
    const night = await s.night();

    expect(night.types).toEqual({ MK0006: ['MEDIA_CHANGED'], MK0008: ['MEDIA_CHANGED'], MK0009: ['MEDIA_CHANGED'] });
    const by: Record<string, any> = Object.fromEntries(night.events.map((e) => [e.stock, e.changes]));
    expect(by.MK0006.added).toEqual([`image:${s.site.url}/img/secure/inventory/images/u6p4.webp`]);
    expect(by.MK0008.removed).toEqual([`image:${s.site.url}/img/secure/inventory/images/u8p3.webp`]);
    expect(by.MK0009).toMatchObject({ added: [], removed: [], count: { old: 3, new: 3 } });
  });

  scenario('new listing at the top shifts every card down a page → only NEW fires', async (s) => {
    await s.night();
    s.site.add(mockUnit(900, { stockNumber: 'NEW0900' }), 'top');
    const night = await s.night();
    expect(night.types).toEqual({ NEW0900: ['NEW'] });
    expect(night.summary.health.healthy).toBe(true);
  });

  scenario('unit disappears: kept through the grace period, REMOVED on the 2nd miss, RELISTED on return', async (s) => {
    await s.night();
    const gone = s.site.remove('MK0010');

    const miss1 = await s.night();
    expect(miss1.events).toEqual([]);
    expect(miss1.stats.missedUnderGrace).toBe(1);

    const miss2 = await s.night();
    expect(miss2.types).toEqual({ MK0010: ['REMOVED'] });
    expect(miss2.events[0]!.changes).toMatchObject({ lastAvailability: 'available', missedRuns: 2 });

    s.site.add(gone, 'bottom');
    const back = await s.night();
    expect(back.types).toEqual({ MK0010: ['RELISTED'] });
    expect((await s.unit('MK0010')).status).toBe('active');
  });

  scenario('stock number re-keyed (same platform id) → DETAILS_CHANGED, not REMOVED + NEW', async (s) => {
    await s.night();
    s.site.update('MK0011', { stockNumber: 'MK0011-R' }); // detail URL embeds stock #, so it moves too
    const night = await s.night();

    expect(night.types).toEqual({ 'MK0011-R': ['DETAILS_CHANGED'] });
    expect(night.events[0]!.changes).toMatchObject({ stockNumber: { old: 'MK0011', new: 'MK0011-R' } });
    expect(night.events[0]!.changes.listingUrl.new).toMatch(/mk0011-r\/$/);
    expect(await s.unitStatuses()).toEqual({ active: 28 });
  });
});
