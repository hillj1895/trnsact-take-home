/**
 * The mock dealer's "database": plain objects a test mutates between nights.
 * Fields mirror what Transwest actually exposes, not our canonical Unit — the
 * point is to exercise the real extraction path end to end.
 */
export interface MockUnit {
  /** Platform id (Transwest `wire:key="product-<id>-N"`). Stable across stock-number edits. */
  id: number;
  group: 'trucks' | 'trailers';
  stockNumber: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  type: string;
  /** As shown in the spec table ("New", "Used", ...). */
  condition: string;
  mileage?: number;
  /** null renders as "Contact For Price" (and the "List Price" spec row is omitted, as on the real site). */
  price: number | null;
  msrp?: number | null;
  /**
   * What the list card's price field shows, when it isn't simply the price. The real
   * site shows "Contact For Price" / "Coming Soon" for unpriced units and "Sold" /
   * "Sale Pending" for some priced ones (the detail page still lists the price).
   */
  cardPriceText?: string;
  /** As displayed: "Available", "Sale Pending", "Sold", "Rental", ... */
  status: string;
  location: string;
  /** Asset ids; rendered as /img/secure/inventory/images/<id>.webp?s=<rotating signature>. */
  images: string[];
  /** Extra spec rows beyond the standard ones. */
  specs: Record<string, string>;
  /** Card title override (real titles include the submodel). Default: "<year> <make> <model>". */
  title?: string;
  submodel?: string;
  /** Detail page path override (e.g. the real site's URL). Default: generated from the unit. */
  path?: string;
  /** Override for `data-product-is-sold` / `-is-rental` (default: derived from `status`). */
  isSold?: boolean;
  isRental?: boolean;
}

const MAKES: Array<[make: string, model: string, type: string]> = [
  ['Freightliner', 'Cascadia 126', 'Sleeper Truck'],
  ['Freightliner', 'M2 106', 'Dump Truck'],
  ['Western Star', '49X', 'Day Cab'],
  ['International', 'HV607', 'Box Truck'],
  ['Kenworth', 'T880', 'Mixer Truck'],
];
const LOCATIONS = ['Transwest of St. Michael, MN', 'Transwest of Denver, CO', 'Transwest of Grand Junction, CO'];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/** Deterministic, valid-looking 17-char VIN from a seed. */
export function mockVin(seed: number): string {
  let x = seed * 2654435761;
  let out = '';
  for (let i = 0; i < 17; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += VIN_CHARS[x % VIN_CHARS.length];
  }
  return out;
}

/** One deterministic unit. `i` drives every field so scenarios are reproducible. */
export function mockUnit(i: number, over: Partial<MockUnit> = {}): MockUnit {
  const [make, model, type] = MAKES[i % MAKES.length]!;
  const used = i % 3 !== 0;
  return {
    id: 1_000_000 + i,
    group: 'trucks',
    stockNumber: `MK${String(i).padStart(4, '0')}`,
    vin: mockVin(i + 1),
    year: 2018 + (i % 7),
    make,
    model,
    type,
    condition: used ? 'Used' : 'New',
    mileage: used ? 50_000 + i * 1_337 : undefined,
    price: i % 4 === 3 ? null : 60_000 + i * 1_000,
    status: 'Available',
    location: LOCATIONS[i % LOCATIONS.length]!,
    images: [1, 2, 3].map((n) => `u${i}p${n}`),
    specs: { 'Exterior Color': ['White', 'Black', 'Blue'][i % 3]!, 'Engine Make': 'Detroit' },
    ...over,
  };
}

/** `trucks` units plus `trailers` units (the real site has two start URLs). */
export function seedInventory(trucks = 25, trailers = 3): MockUnit[] {
  return [
    ...Array.from({ length: trucks }, (_, i) => mockUnit(i)),
    ...Array.from({ length: trailers }, (_, i) =>
      mockUnit(500 + i, { group: 'trailers', make: 'Utility', model: '4000D-X', type: 'Dry Van Trailer', mileage: undefined }),
    ),
  ];
}
