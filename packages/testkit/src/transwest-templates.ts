import type { MockUnit } from './inventory.js';

/**
 * Minimal re-creation of Transwest's server-rendered markup: only the parts the
 * real `sources/transwest.json` config reads (card data-* attributes, the
 * `data-form-attributes` JSON blob, `wire:key`, the "1 - 19 / 332" total,
 * schema.org Vehicle JSON-LD and the spec list). Real-site quirks are kept on
 * purpose: JSON-LD always claims NewCondition, and the detail page shows only
 * the last 6 of the VIN.
 *
 * `layout: 'redesign'` simulates the dealer shipping a new front end: cards
 * render with different markup, so the config's selectors match nothing.
 */
export type Layout = 'current' | 'redesign';

export interface RenderContext {
  /** Changes every night so image URLs carry a fresh signed query string, like the real CDN. */
  imageSignature: string;
  layout: Layout;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export const priceText = (u: MockUnit) => (u.price === null ? 'Contact For Price' : usd(u.price));
export const title = (u: MockUnit) => `${u.year} ${u.make} ${u.model}`;

/** Detail URL path. Embeds the stock number, so a re-keyed unit moves to a new URL (as on the real site). */
export function detailPath(u: MockUnit): string {
  const store = slug(u.location.replace(/^Transwest of /, '')) + '-commercial-trucks-and-trailers';
  return `/${u.group}/type/${slug(u.type)}/store/${store}/${slug(`${u.condition} ${title(u)} ${u.stockNumber}`)}/`;
}

export function imageUrl(baseUrl: string, assetId: string, ctx: RenderContext): string {
  return `${baseUrl}/img/secure/inventory/images/${assetId}.webp?s=${ctx.imageSignature}`;
}

export function renderListPage(
  baseUrl: string,
  units: MockUnit[],
  page: { index: number; pageSize: number; total: number },
  ctx: RenderContext,
): string {
  const from = page.index * page.pageSize + 1;
  const to = Math.min(page.total, from + units.length - 1);
  const cards = units.map((u, i) => (ctx.layout === 'redesign' ? redesignCard(u) : card(u, i))).join('\n');
  return `<!doctype html><html><head><title>Inventory</title></head><body>
  <div class="faceted-search-pagination-sort-clear" data-faceted-search-pagination-sort-clear>
    <span>${units.length ? `${from} - ${to}` : '0 - 0'} / ${page.total}</span>
  </div>
  <ul class="faceted-search-inventory__results">
${cards}
  </ul>
</body></html>`;
}

function card(u: MockUnit, i: number): string {
  const form = {
    color_exterior: u.specs['Exterior Color'] ?? '',
    location: u.location.replace(/^Transwest of /, '').split(',')[0],
    make: u.make,
    mileage: u.mileage ?? null,
    model: u.model,
    status: u.status,
    stock_id: u.stockNumber,
    submodel: '',
    vehicle_type: u.type,
    vin: u.vin,
    year: String(u.year),
    condition: u.condition,
  };
  return `<li
    class="generic-card vehicle-card"
    data-comp-vehicle-card
    data-product-stock-id="${esc(u.stockNumber)}"
    data-product-url="${esc(detailPath(u))}"
    data-product-title="${esc(title(u))} "
    data-product-price="${esc(priceText(u))}"
    data-product-msrp=""
    data-product-location="${esc(u.location)}"
    data-product-is-rental="${u.status === 'Rental'}"
    data-product-is-sold="${u.status === 'Sold'}"
    data-form-attributes="${esc(JSON.stringify(form))}"
    wire:key="product-${u.id}-${i}" wire:ignore=""
  ><h3>${esc(title(u))}</h3></li>`;
}

function redesignCard(u: MockUnit): string {
  return `<article class="inventory-tile" data-vehicle-id="${u.id}">
    <a href="${esc(detailPath(u))}">${esc(title(u))}</a><p class="price">${esc(priceText(u))}</p>
  </article>`;
}

export function renderDetailPage(baseUrl: string, u: MockUnit, ctx: RenderContext): string {
  const url = baseUrl + detailPath(u);
  const jsonLd = {
    '@context': 'http://schema.org',
    '@type': 'Vehicle',
    url,
    name: title(u),
    sku: u.stockNumber,
    vehicleIdentificationNumber: u.vin,
    itemCondition: 'NewCondition', // real-site bug, kept: the spec table is the source of truth
    manufacturer: { '@type': 'Organization', name: u.make },
    model: u.model,
    bodyType: u.type,
    image: u.images.map((id, n) => ({ '@type': 'ImageObject', url: imageUrl(baseUrl, id, ctx), name: `${title(u)} - Photo ${n + 1}` })),
    ...(u.price !== null ? { offers: { '@type': 'Offer', price: u.price, priceCurrency: 'USD' } } : {}),
  };
  const specs: Array<[string, string]> = [
    ['Type', u.type],
    ['Year', String(u.year)],
    ['Make', u.make],
    ['Model', u.model],
    ['Stock ID', u.stockNumber],
    ['VIN (Last 6)', u.vin.slice(-6)],
    ['List Price', priceText(u)],
    ['Status', u.status],
    ['Condition', u.condition],
    ...(u.mileage !== undefined ? [['Mileage', u.mileage.toLocaleString('en-US')] as [string, string]] : []),
    ...Object.entries(u.specs),
  ];
  return `<!doctype html><html><head><title>${esc(title(u))}</title>
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head><body>
  <h1>${esc(title(u))}</h1>
  <h2>Specifications</h2>
  <ul class="section-product-specs__list">
${specs.map(([k, v]) => `    <li><span>${esc(k)}</span> ${esc(v)}</li>`).join('\n')}
  </ul>
</body></html>`;
}
