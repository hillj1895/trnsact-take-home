import type { Unit } from '@trnsact/core';
import type { MockUnit } from './inventory.js';

/** Spec rows the Transwest template renders itself from MockUnit fields. */
const TEMPLATE_SPECS = new Set(['Type', 'Year', 'Make', 'Model', 'Stock ID', 'VIN (Last 6)', 'List Price', 'Status', 'Condition', 'Mileage']);
const IMAGE_PATH = '/img/secure/inventory/images/';

/**
 * Turn a unit from a REAL crawl back into mock-site inventory, so the mock
 * dealer can serve the real lot (same paths, ids, specs and photo asset ids,
 * different host). Lets simulations run on real data instead of synthetic seeds.
 */
export function mockUnitFromUnit(u: Unit): MockUnit {
  const url = new URL(u.listingUrl);
  const specs = Object.fromEntries(Object.entries(u.specs).filter(([k]) => !TEMPLATE_SPECS.has(k)));
  return {
    id: Number(u.platformId ?? u.sourceUnitKey),
    group: url.pathname.startsWith('/trailers/') ? 'trailers' : 'trucks',
    path: url.pathname,
    stockNumber: u.stockNumber ?? u.sourceUnitKey,
    vin: u.vin ?? '',
    year: u.year ?? 0,
    make: u.make ?? '',
    model: u.model ?? '',
    type: u.specs.Type ?? u.category ?? '',
    condition: u.specs.Condition ?? (u.condition === 'new' ? 'New' : 'Used'),
    mileage: u.mileage,
    price: u.price.amount,
    msrp: u.price.msrp,
    cardPriceText: u.price.text,
    status: u.availabilityRaw ?? u.specs.Status ?? '',
    location: u.location ?? '',
    images: u.media
      .filter((m) => m.kind === 'image' && m.url.includes(IMAGE_PATH))
      .map((m) => new URL(m.url).pathname.slice(IMAGE_PATH.length)),
    specs,
    title: u.title,
    submodel: u.submodel,
    isSold: u.availability === 'sold',
    isRental: u.isRental,
  };
}
