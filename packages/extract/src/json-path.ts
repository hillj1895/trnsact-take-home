/**
 * Tiny dot-path resolver. Always returns a flat list of leaf values so that
 * single-value and multi-value (e.g. "image[].url") paths share one code path.
 *
 *   "vin"              -> [obj.vin]
 *   "items[0].price"   -> [obj.items[0].price]
 *   "image[].url"      -> obj.image.map(i => i.url)
 */
export function getPath(input: unknown, path: string): unknown[] {
  const segments = path.split('.').filter(Boolean);
  let current: unknown[] = [input];

  for (const segment of segments) {
    const match = /^([^[\]]*)((?:\[\d*\])*)$/.exec(segment);
    if (!match) return [];
    const [, key, brackets = ''] = match;
    let next: unknown[] = [];

    for (const value of current) {
      const v = key ? (isRecord(value) ? value[key] : undefined) : value;
      if (v !== undefined) next.push(v);
    }

    for (const bracket of brackets.match(/\[\d*\]/g) ?? []) {
      const index = bracket.slice(1, -1);
      const expanded: unknown[] = [];
      for (const value of next) {
        if (!Array.isArray(value)) continue;
        if (index === '') expanded.push(...value);
        else if (value[Number(index)] !== undefined) expanded.push(value[Number(index)]);
      }
      next = expanded;
    }

    // A bare key that lands on an array of objects keeps the array; callers use [] to flatten.
    current = next;
  }

  return current.filter((v) => v !== undefined && v !== null);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
