import type { TransformName } from '@trnsact/core';

export type Scalar = string | number | boolean | null;

export interface TransformContext {
  pageUrl: string;
}

const toNumber = (v: Scalar): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/**
 * The transform vocabulary configs can use. Deliberately small and named —
 * configs reference these by name, so adding one is a code change, but using
 * any combination of existing ones is just data.
 */
const TRANSFORM_IMPLS: Record<TransformName, (v: Scalar, ctx: TransformContext) => Scalar> = {
  trim: (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v),
  number: (v) => toNumber(v),
  int: (v) => {
    const n = toNumber(v);
    return n === null ? null : Math.trunc(n);
  },
  // "Call for price", "Contact us" etc. => null rather than a bogus 0.
  price: (v) => {
    const n = toNumber(v);
    return n === null || n <= 0 ? null : n;
  },
  absUrl: (v, ctx) => {
    if (typeof v !== 'string' || !v.trim()) return v;
    try {
      return new URL(v.trim(), ctx.pageUrl).toString();
    } catch {
      return null;
    }
  },
  stripQuery: (v) => (typeof v === 'string' ? v.split(/[?#]/)[0]! : v),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  bool: (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(s)) return true;
    if (['false', 'no', 'n', '0'].includes(s)) return false;
    return null;
  },
  nullIfEmpty: (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
};

export function applyTransforms(value: Scalar, names: readonly TransformName[], ctx: TransformContext): Scalar {
  let v = value;
  for (const name of names) {
    if (v === null) return null;
    v = TRANSFORM_IMPLS[name](v, ctx);
  }
  return v;
}

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
