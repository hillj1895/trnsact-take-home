import { describe, expect, it } from 'vitest';
import { canonicalJson, facetHashes, type Unit } from '../src/index.js';

const base: Unit = {
  sourceId: 's',
  dealerId: 'd',
  sourceUnitKey: '1',
  listingUrl: 'https://x.test/u/1',
  stockNumber: 'A1',
  year: 2019,
  make: 'Freightliner',
  model: 'M2 106',
  condition: 'used',
  price: { amount: 79900, msrp: null, currency: 'USD', text: '$79,900' },
  availability: 'available',
  specs: { 'Engine Make': 'Cummins', 'List Price': '$79,900' },
  media: [{ kind: 'image', url: 'https://x.test/i/1.webp?s=abc', key: 'image:https://x.test/i/1.webp', position: 0 }],
  scrapedAt: '2026-01-01T00:00:00.000Z',
  warnings: [],
};
const opts = { ignoreSpecs: ['List Price'] };
const h = (u: Unit) => facetHashes(u, opts);

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
  });
});

describe('facetHashes', () => {
  it('ignores run noise: scrapedAt, warnings, signed media URLs', () => {
    const noisy: Unit = {
      ...base,
      scrapedAt: '2026-02-02T00:00:00.000Z',
      warnings: ['something'],
      media: [{ ...base.media[0]!, url: 'https://x.test/i/1.webp?s=rotated' }],
    };
    expect(h(noisy)).toEqual(h(base));
  });

  it('isolates a price change to the price facet (ignored spec label included)', () => {
    const cut: Unit = {
      ...base,
      price: { ...base.price, amount: 74900, text: '$74,900' },
      specs: { ...base.specs, 'List Price': '$74,900' },
    };
    expect(h(cut).price).not.toEqual(h(base).price);
    expect(h(cut).details).toEqual(h(base).details);
    expect(h(cut).media).toEqual(h(base).media);
  });

  it('detects spec, media-order and hidden-price changes', () => {
    expect(h({ ...base, specs: { ...base.specs, 'Engine Make': 'Detroit' } }).details).not.toEqual(h(base).details);
    expect(h({ ...base, price: { ...base.price, amount: null, text: 'Contact For Price' } }).price).not.toEqual(
      h(base).price,
    );
    const two = [base.media[0]!, { ...base.media[0]!, key: 'image:https://x.test/i/2.webp', position: 1 }];
    expect(h({ ...base, media: two }).media).not.toEqual(h({ ...base, media: [...two].reverse() }).media);
  });
});
