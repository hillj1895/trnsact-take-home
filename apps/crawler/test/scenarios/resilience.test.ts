import { expect } from 'vitest';
import { describeScenarios } from './harness.js';

/**
 * "Our view of the site broke overnight" — the system must not mistake a bad
 * scrape for real inventory change. The worst failure mode is a broken crawl
 * that looks like a dealer sold its whole lot.
 */
describeScenarios('resilience (faults on the mock dealer)', (scenario) => {
  scenario('list page 2 returns 500 all night: run unhealthy, nothing counted missing or removed', async (s) => {
    await s.night();
    s.site.failListPage(2);
    for (let i = 0; i < 3; i++) {
      const broken = await s.night();
      expect(broken.summary.health.healthy).toBe(false);
      expect(broken.summary.health.reasons).toContain('list page failure (inventory view incomplete)');
      expect(broken.stats.removalCheck).toMatch(/skipped/);
      expect(broken.events).toEqual([]);
    }
    expect(await s.unitStatuses()).toEqual({ active: 28 });

    s.site.clearFaults();
    const recovered = await s.night();
    expect(recovered.events).toEqual([]);
    expect(recovered.summary.health.healthy).toBe(true);
  });

  scenario('transient 429 / 503s are retried: run healthy, no events', async (s) => {
    await s.night();
    s.site.failListPage(1, { status: 429, times: 1 });
    s.site.failDetail('MK0001', { status: 503, times: 2 });
    const night = await s.night();
    expect(night.summary.health.healthy).toBe(true);
    expect(night.summary.http.retries).toBe(3);
    expect(night.events).toEqual([]);
  });

  scenario('one detail page keeps failing: unit kept from list data, no phantom DETAILS/MEDIA changes', async (s) => {
    await s.night();
    // Same night: detail page down AND a real price cut visible on the list card.
    s.site.failDetail('MK0012');
    s.site.update('MK0012', { price: 70_000 });
    const degraded = await s.night();

    expect(degraded.summary.counts.detailFailed).toBe(1);
    expect(degraded.summary.health.healthy).toBe(true); // 1/28 is under the 5% threshold
    // The price change is real (seen on the card); the empty specs/media are not.
    expect(degraded.types).toEqual({ MK0012: ['PRICE_CHANGED'] });
    expect((await s.unit('MK0012')).data.media).toHaveLength(3);

    s.site.clearFaults();
    const recovered = await s.night();
    expect(recovered.events).toEqual([]);
  });

  scenario('brand-new unit whose detail page is down: stored list-only, quietly backfilled next night', async (s) => {
    await s.night();
    s.site.add({ ...s.site.unit('MK0000'), id: 2_000_000, stockNumber: 'NEW2000', vin: 'NEWVIN00000002000', images: ['n1', 'n2'] });
    s.site.failDetail('NEW2000');
    const first = await s.night();
    expect(first.types).toEqual({ NEW2000: ['NEW'] });
    expect((await s.unit('NEW2000')).data).toMatchObject({ detailStatus: 'failed', media: [] });

    s.site.clearFaults();
    const backfilled = await s.night();
    expect(backfilled.events).toEqual([]); // specs + photos arrived, but nothing *changed*
    expect((await s.unit('NEW2000')).data).toMatchObject({ detailStatus: 'ok', media: [{}, {}] });
  });

  scenario('list-only run (--no-detail) still tracks price/availability without phantom changes', async (s) => {
    await s.night();
    s.site.update('MK0001', { price: 55_000 });
    s.site.update('MK0002', { status: 'Sold' });
    const listOnly = await s.night({ detail: false });
    expect(s.site.hits(/\/store\/[^?]+\/$/).filter((r) => !/type\/all/.test(r.path))).toEqual([]); // no detail fetches
    expect(listOnly.types).toEqual({ MK0001: ['PRICE_CHANGED'], MK0002: ['AVAILABILITY_CHANGED'] });
  });

  scenario('site redesign (selectors match nothing): unhealthy every night, no mass removal', async (s) => {
    await s.night();
    s.site.layout = 'redesign';
    for (let i = 0; i < 3; i++) {
      const night = await s.night();
      expect(night.summary.counts.discovered).toBe(0);
      expect(night.summary.health.healthy).toBe(false);
      expect(night.summary.health.reasons).toEqual(expect.arrayContaining(['zero units discovered']));
      expect(night.events).toEqual([]);
    }
    expect(await s.unitStatuses()).toEqual({ active: 28 });
  });

  scenario('partial run (--limit) never removes units it did not look at', async (s) => {
    await s.night();
    for (let i = 0; i < 3; i++) {
      const partial = await s.night({ limit: 5 });
      expect(partial.summary.partial).toBe(true);
      expect(partial.stats.removalCheck).toMatch(/skipped/);
    }
    expect(await s.unitStatuses()).toEqual({ active: 28 });
  });

  scenario('pagination stops at the site total, even if the server repeats page 1 for out-of-range pages', async (s) => {
    const night = await s.night();
    expect(night.summary.counts).toMatchObject({ discovered: 28, duplicateKeys: 0 });
    // 25 trucks / 10 per page = 3 pages; trailers fit on 1. No speculative page 4.
    expect(s.site.hits(/^\/trucks\/type\/all\/store\//)).toHaveLength(3);
    expect(s.site.hits(/^\/trailers\/type\/all\/store\//)).toHaveLength(1);
  }, { outOfRangePage: 'first-page' });

  scenario('crawler identifies with the configured User-Agent on every request', async (s) => {
    await s.night();
    const agents = new Set(s.site.requests.map((r) => r.userAgent));
    expect([...agents]).toEqual([s.config.http.userAgent]);
  });
});
