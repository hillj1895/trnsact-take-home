import type { FieldName, MediaItem, Pagination, SourceConfig } from '@trnsact/core';
import { evaluateRule, extractValues, type Scope } from '../extract.js';
import { findJsonLd, loadPage, parseSpecs, type Page } from '../page.js';
import { applyTransforms } from '../transforms.js';
import type {
  DetailResult,
  DiscoverOptions,
  Driver,
  DriverContext,
  ListingStub,
  ListPageResult,
  RawFields,
} from './types.js';

/**
 * Driver for server-rendered HTML sites: paginated list pages of unit cards,
 * plus an optional per-unit detail page. Covers classic CMS/agency builds,
 * Livewire/Rails/ASP.NET sites, and SSR'd React/Vue apps.
 */
export const htmlDriver: Driver = {
  name: 'html',

  async *discover(ctx: DriverContext, opts: DiscoverOptions = {}): AsyncIterable<ListPageResult> {
    const { config, http, logger } = ctx;
    for (const start of config.list.startUrls) {
      const startUrl = new URL(start, config.baseUrl).toString();
      const seen = new Set<string>();
      let url: string | undefined = pageUrl(startUrl, config.list.pagination, 0);
      let index = 0;
      const limit = Math.min(maxPages(config.list.pagination), opts.maxPages ?? Infinity);

      while (url && index < limit) {
        const res = await http.get(url);
        const result = parseListPage(config, res.body, res.url);
        const fresh = result.stubs.filter((s) => !seen.has(s.key));
        fresh.forEach((s) => seen.add(s.key));
        logger.info('list.page', {
          url,
          page: index + 1,
          items: result.stubs.length,
          new: fresh.length,
          siteTotal: result.siteTotal,
        });
        yield { ...result, stubs: fresh };

        // Stop conditions, most to least specific. The "no new keys" guard catches
        // sites that silently ignore an out-of-range page param and return page 1.
        if (result.stubs.length === 0 || fresh.length === 0) break;
        if (result.siteTotal !== undefined && seen.size >= result.siteTotal) break;

        index++;
        url =
          config.list.pagination.type === 'nextLink'
            ? result.nextUrl
            : config.list.pagination.type === 'none'
              ? undefined
              : pageUrl(startUrl, config.list.pagination, index);
      }
    }
  },

  async fetchDetail(ctx: DriverContext, stub: ListingStub): Promise<DetailResult> {
    const res = await ctx.http.get(stub.url);
    return parseDetailPage(ctx.config, res.body, res.url);
  },
};

function maxPages(p: Pagination): number {
  return p.type === 'none' ? 1 : p.maxPages;
}

function pageUrl(startUrl: string, p: Pagination, index: number): string {
  if (p.type !== 'queryParam') return startUrl;
  const u = new URL(startUrl);
  u.searchParams.set(p.param, String(p.start + index * p.step));
  return u.toString();
}

/** Pure: list-page HTML → stubs. Exported for offline fixture tests and `probe`. */
export function parseListPage(config: SourceConfig, html: string, url: string): ListPageResult {
  const page = loadPage(html, url);
  const { $ } = page;

  const stubs: ListingStub[] = [];
  $(config.list.item).each((_, el) => {
    const scope: Scope = { page, el: $(el) };
    const { fields, warnings } = evaluateFields(config.list.fields, scope, 'list');
    const listingUrl = typeof fields.listingUrl === 'string' ? fields.listingUrl : undefined;
    const key = identityOf(config, fields);
    if (!listingUrl || !key) {
      // A card we can't identify or follow is useless; skip loudly rather than invent an id.
      warnings.push(`card skipped: missing ${!listingUrl ? 'listingUrl' : 'identity'}`);
      return;
    }
    stubs.push({ key, url: listingUrl, fields, warnings, foundOn: url });
  });

  let siteTotal: number | undefined;
  if (config.list.total) {
    const v = extractValues(config.list.total, { page })[0];
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9]/g, ''));
    if (Number.isFinite(n) && n > 0) siteTotal = n;
  }

  let nextUrl: string | undefined;
  if (config.list.pagination.type === 'nextLink') {
    const href = $(config.list.pagination.selector).first().attr('href');
    if (href) nextUrl = new URL(href, url).toString();
  }

  return { pageUrl: url, stubs, siteTotal, nextUrl };
}

/** Pure: detail-page HTML → fields, specs and media. */
export function parseDetailPage(config: SourceConfig, html: string, url: string): DetailResult {
  const detail = config.detail;
  const page = loadPage(html, url);
  const warnings: string[] = [];

  let jsonLd: Record<string, unknown> | undefined;
  if (detail?.jsonLd) {
    const nodes = findJsonLd(page, detail.jsonLd.type);
    jsonLd = nodes[0];
    if (!jsonLd) warnings.push(`no JSON-LD node of type ${detail.jsonLd.type}`);
  }
  const specs = parseSpecs(page, detail?.specs ?? []);
  const scope: Scope = { page, jsonLd, specs };

  const result = evaluateFields(detail?.fields ?? {}, scope, 'detail');
  warnings.push(...result.warnings);

  return { url, fields: result.fields, specs, media: extractMedia(config, scope), warnings };
}

function evaluateFields(
  rules: SourceConfig['list']['fields'],
  scope: Scope,
  stage: 'list' | 'detail',
): { fields: RawFields; warnings: string[] } {
  const fields: RawFields = {};
  const warnings: string[] = [];
  for (const [name, rule] of Object.entries(rules) as [FieldName, NonNullable<(typeof rules)[FieldName]>][]) {
    const { value, conflicts } = evaluateRule(rule, scope);
    if (value !== undefined) fields[name] = value;
    if (conflicts.length) {
      warnings.push(`${stage}.${name}: sources disagree, using "${value}" over ${conflicts.map((c) => `"${c}"`).join(', ')}`);
    }
  }
  return { fields, warnings };
}

function identityOf(config: SourceConfig, fields: RawFields): string | undefined {
  for (const name of config.identity) {
    const v = fields[name];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function extractMedia(config: SourceConfig, scope: Scope): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  for (const rule of config.detail?.media ?? []) {
    const include = rule.include ? new RegExp(rule.include, 'i') : undefined;
    const exclude = rule.exclude ? new RegExp(rule.exclude, 'i') : undefined;
    for (const v of extractValues(rule.extract, scope)) {
      const url = applyTransforms(v, ['absUrl'], { pageUrl: scope.page.url });
      if (typeof url !== 'string') continue;
      if (include && !include.test(url)) continue;
      if (exclude && exclude.test(url)) continue;
      // Identity ignores query strings: signed/resized variants of one asset collapse to one key.
      const key = `${rule.kind}:${url.split(/[?#]/)[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: rule.kind, url, key, position: out.filter((m) => m.kind === rule.kind).length });
    }
  }
  return out;
}
