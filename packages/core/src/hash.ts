import { createHash } from 'node:crypto';
import type { Unit } from './unit.js';

/**
 * Deterministic JSON: object keys sorted recursively, undefined dropped.
 * Two semantically equal units always serialize — and therefore hash — identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortDeep(child);
    }
    return out;
  }
  return v;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export interface FacetHashOptions {
  /** Spec labels excluded from the details facet (case-insensitive). */
  ignoreSpecs?: readonly string[];
}

/** The fields that make up the "details" facet. */
export function detailsFacet(unit: Unit, opts: FacetHashOptions = {}) {
  const ignore = new Set((opts.ignoreSpecs ?? []).map((s) => s.toLowerCase()));
  const specs = Object.fromEntries(Object.entries(unit.specs).filter(([k]) => !ignore.has(k.toLowerCase())));
  return {
    listingUrl: unit.listingUrl,
    platformId: unit.platformId,
    stockNumber: unit.stockNumber,
    vin: unit.vin,
    serialNumber: unit.serialNumber,
    title: unit.title,
    year: unit.year,
    make: unit.make,
    model: unit.model,
    submodel: unit.submodel,
    category: unit.category,
    condition: unit.condition,
    mileage: unit.mileage,
    hours: unit.hours,
    location: unit.location,
    description: unit.description,
    isRental: unit.isRental,
    specs,
  };
}

/**
 * One hash per independently-changing facet. Deliberately excluded everywhere:
 * scrapedAt, warnings, and media URL query strings (signatures rotate nightly) —
 * otherwise every run would look like every unit changed.
 */
export function facetHashes(unit: Unit, opts: FacetHashOptions = {}) {
  return {
    details: sha256(canonicalJson(detailsFacet(unit, opts))),
    price: sha256(canonicalJson({ amount: unit.price.amount, msrp: unit.price.msrp, text: unit.price.text })),
    media: sha256(canonicalJson(unit.media.map((m) => m.key))),
  };
}
export type FacetHashes = ReturnType<typeof facetHashes>;
