# Dealer Inventory Crawler

Nightly scraper for commercial truck / equipment dealer inventory. Built for one dealer
([Transwest](https://www.transwest.com)), designed so that adding the next thousand is mostly
**configuration, not code**.

## Quick start

```bash
corepack enable          # provides pnpm 9 (pinned in package.json)
pnpm install
pnpm test                # unit tests + offline fixture contract tests
pnpm crawl transwest     # full live crawl → .output/transwest/<runId>/
```

Useful flags: `--max-pages 1 --limit 5` (quick partial run), `--no-detail` (list pages only).

| Command | What it does |
|---|---|
| `pnpm crawl <id\|all>` | Crawl one source or every enabled source; writes `units.ndjson`, `errors.ndjson`, `summary.json` |
| `pnpm probe <id> [--limit N]` | Live check while authoring a config — prints normalized units, writes nothing |
| `pnpm sources:list` / `sources:validate` | List / validate all source configs (validate exits non-zero → CI gate) |
| `pnpm fixtures:capture <id>` | Save list page 1 + one detail page as offline test fixtures |

## Layout

```
packages/
  core/      Contracts: canonical Unit schema, declarative SourceConfig schema, logger
  http/      Polite HTTP client: per-source rate limit, concurrency cap, retry/backoff, Retry-After
  extract/   Generic engine: extractor interpreter, JSON-LD + spec-table parsing, drivers, normalizer
apps/
  crawler/   CLI + run pipeline (discover → detail → normalize → validate → output + run summary)
sources/
  <id>.json              One declarative config per dealer site
  fixtures/<id>/         Saved pages + manifest.json expectations for the contract test
```

Dependencies flow one way: `crawler → extract → http → core`. Sources contain no code.

## How the generic system works

Two halves:

- **Drivers (code)** know how to talk to a *kind* of site. Today: `html` (server-rendered list
  pages + optional detail pages). Planned: `json-api` (sites backed by Algolia / a vendor search
  API), `browser` (Playwright, for client-rendered SPAs — the expensive last resort).
- **Source configs (data)** say where things are on *one* site: start URLs, pagination, card
  selector, and a field map. Each field is an extractor or an ordered fallback chain:

```jsonc
"stockNumber": [
  { "from": "spec",   "label": "Stock ID" },          // visible spec table first
  { "from": "jsonld", "path": "sku" }                 // schema.org fallback
],
"vin":   { "attr": "data-form-attributes", "json": "vin", "transforms": ["upper"] },
"price": { "attr": "data-product-price", "transforms": ["price"] }   // "Contact For Price" → null
```

Extractor sources: `dom` (selector/attr/text, optional JSON-in-attribute path), `jsonld`,
`spec` (by label), `const`. Post-processing: `regex`, named `transforms`, value `map`.
When a chain's sources **disagree**, the first wins and the disagreement is recorded as a
warning — e.g. Transwest's JSON-LD claims every unit is `NewCondition`; the spec table says
`Used`.

Configs are loaded at runtime through a `ConfigStore` interface (files today; S3 or a DB table
in production), so **onboarding or fixing a dealer on an existing driver needs no deployment.**
Only a new driver or transform ships code.

### Onboarding a dealer

1. Fingerprint the site (view source / network tab): SSR HTML? embedded JSON? a search API?
   Same platform as an existing source? If so, copy that config.
2. Write `sources/<id>.json`; iterate with `pnpm probe <id>`.
3. `pnpm fixtures:capture <id>`, set expectations in `sources/fixtures/<id>/manifest.json`.
4. `pnpm test` — schema validation, list/detail contract checks and a golden snapshot.
5. Ship the config (PR today; config store + review UI later). When a layout changes:
   re-capture, watch the test go red, fix the config, bump `version`.

## Run health

Every run writes `summary.json`: site-reported total vs discovered (coverage), field fill rates,
invalid/detail-failure rates, warning buckets, HTTP stats. A run is **healthy** only if coverage
≥ 95%, invalid ≤ 2%, detail failures ≤ 5%, no list-page failures, and it wasn't partial.
Downstream change detection must only mark units *removed* after a healthy run — a broken
scrape must never look like a dealer selling its whole lot.

Failure handling: a failed list page marks the run unhealthy; a failed detail page degrades
the unit to list-only data (still proves existence, price, availability) rather than dropping it.

## Platform survey (Nov 2026)

| Dealer | Platform / rendering | Implication |
|---|---|---|
| Transwest | Agency build, Laravel Livewire, SSR; data-* attrs + JSON-LD | `html` driver |
| Fyda Freightliner, Worldwide Equipment | **Dealer Spike** (shared `/inventory/v1/`, `--xNewInventory` URLs) | one config template → many dealers |
| Premier Truck Group | Next.js + RideMotive inventory API | `json-api` driver candidate |
| Rush Truck Centers | Custom, JSON-LD present | `html` driver |
| MHC Kenworth | Sitecore | `html` driver |

Takeaway: a long tail of custom sites, but a meaningful share sits on a handful of dealer
platforms, where one config template covers every dealer on that platform.

## Not built yet

Persistence + change detection (DB schema, run-over-run diffing), media download/hashing, and
the AWS deployment.
