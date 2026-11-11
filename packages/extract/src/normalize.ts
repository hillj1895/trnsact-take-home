import { Unit, type Availability, type Condition, type FieldName, type SourceConfig } from '@trnsact/core';
import { sameValue } from './extract.js';
import type { DetailResult, ListingStub, RawFields } from './drivers/types.js';
import type { Scalar } from './transforms.js';

/** Sensible defaults; each source config can extend/override via `normalize`. Keys are lower-case. */
const DEFAULT_AVAILABILITY: Record<string, Availability> = {
  available: 'available',
  'in stock': 'available',
  instock: 'available',
  pending: 'pending',
  'sale pending': 'pending',
  'on hold': 'pending',
  'deposit taken': 'pending',
  sold: 'sold',
  'on order': 'on_order',
  'in transit': 'on_order',
  'coming soon': 'on_order',
};

const DEFAULT_CONDITION: Record<string, Condition> = {
  new: 'new',
  used: 'used',
  'pre-owned': 'used',
  preowned: 'used',
  'certified pre-owned': 'used',
  newcondition: 'new',
  usedcondition: 'used',
};

export type NormalizeResult = { ok: true; unit: Unit } | { ok: false; errors: string[]; partial: unknown };

export function normalizeUnit(
  config: SourceConfig,
  stub: ListingStub,
  detail: DetailResult | undefined,
  scrapedAt: string,
  opts: { detailStatus?: Unit['detailStatus'] } = {},
): NormalizeResult {
  const warnings = [...stub.warnings, ...(detail?.warnings ?? [])];
  const fields = mergeFields(stub.fields, detail?.fields ?? {}, warnings);

  const availabilityRaw = str(fields.availability);
  const isSold = bool(fields.isSold);
  let availability: Availability = 'unknown';
  if (isSold) availability = 'sold';
  else if (availabilityRaw) {
    const mapped = lookup({ ...DEFAULT_AVAILABILITY, ...lowerKeys(config.normalize.availability) }, availabilityRaw);
    if (mapped) availability = mapped;
    else warnings.push(`unmapped availability "${availabilityRaw}"`);
  }

  const conditionRaw = str(fields.condition);
  let condition: Condition = 'unknown';
  if (conditionRaw) {
    const mapped = lookup({ ...DEFAULT_CONDITION, ...lowerKeys(config.normalize.condition) }, conditionRaw);
    if (mapped) condition = mapped;
    else warnings.push(`unmapped condition "${conditionRaw}"`);
  }

  const vin = str(fields.vin)?.toUpperCase().replace(/\s+/g, '');
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) warnings.push(`VIN "${vin}" is not a valid 17-char VIN`);

  const candidate = {
    sourceId: config.id,
    dealerId: config.dealer.id,
    sourceUnitKey: stub.key,
    listingUrl: str(fields.listingUrl) ?? stub.url,
    platformId: str(fields.platformId),
    stockNumber: str(fields.stockNumber),
    vin,
    serialNumber: str(fields.serialNumber),
    title: str(fields.title),
    year: int(fields.year),
    make: str(fields.make),
    model: str(fields.model),
    submodel: str(fields.submodel),
    category: str(fields.category),
    condition,
    mileage: num(fields.mileage),
    hours: num(fields.hours),
    price: {
      amount: num(fields.price) ?? null,
      msrp: num(fields.msrp) ?? null,
      currency: 'USD' as const,
      text: str(fields.priceText),
    },
    availability,
    availabilityRaw,
    isRental: bool(fields.isRental),
    location: str(fields.location),
    description: str(fields.description),
    specs: detail?.specs ?? {},
    media: detail?.media ?? [],
    detailStatus: opts.detailStatus,
    scrapedAt,
    warnings,
  };

  const parsed = Unit.safeParse(candidate);
  if (parsed.success) return { ok: true, unit: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    partial: candidate,
  };
}

/** Detail values win over list values; a disagreement is kept as a warning (useful layout-drift signal). */
function mergeFields(list: RawFields, detail: RawFields, warnings: string[]): RawFields {
  const merged: RawFields = { ...list };
  for (const [name, value] of Object.entries(detail) as [FieldName, Scalar][]) {
    const prior = merged[name];
    if (prior !== undefined && prior !== null && value !== null && !sameValue(prior, value)) {
      warnings.push(`${name}: list "${prior}" vs detail "${value}" (using detail)`);
    }
    if (value !== null && value !== undefined) merged[name] = value;
  }
  return merged;
}

function lookup<T>(table: Record<string, T>, raw: string): T | undefined {
  return table[raw.trim().toLowerCase()];
}

function lowerKeys<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.toLowerCase(), v]));
}

function str(v: Scalar | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || undefined;
}

function num(v: Scalar | undefined): number | undefined {
  if (v === null || v === undefined || typeof v === 'boolean') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v).match(/\d/) ? n : undefined;
}

function int(v: Scalar | undefined): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}

function bool(v: Scalar | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
}
