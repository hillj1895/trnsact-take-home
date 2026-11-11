# Dealer Inventory Crawler

Nightly scraper for commercial truck / equipment dealer inventory. Built for one dealer
([Transwest](https://www.transwest.com)), designed so that adding the next thousand is mostly
**configuration, not code**.

## Quick start

```bash
corepack enable          # provides pnpm 9 (pinned in package.json)
pnpm install
pnpm test                # unit tests + offline fixture contract tests

cp .env.example .env     # DATABASE_URL for the compose Postgres
pnpm db:up               # Postgres 16 in Docker (or point DATABASE_URL at any PG 14+)
pnpm crawl transwest     # live crawl → .output/transwest/<runId>/ → persisted + change-detected

# See every change type without waiting a night (wipes the DB):
pnpm demo:changes .output/transwest/<runId> --reset
```

Useful flags: `--max-pages 1 --limit 5` (quick partial run), `--no-detail` (list pages only),
`--no-persist` (skip the DB).

| Command | What it does |
|---|---|
| `pnpm crawl <id\|all>` | Crawl one source or every enabled source; writes `units.ndjson`, `errors.ndjson`, `summary.json` |
| `pnpm probe <id> [--limit N]` | Live check while authoring a config — prints normalized units, writes nothing |
| `pnpm sources:list` / `sources:validate` | List / validate all source configs (validate exits non-zero → CI gate) |
| `pnpm fixtures:capture <id>` | Save list page 1 + one detail page as offline test fixtures |
| `pnpm import <runDir>` | Persist a saved run directory into the DB |
| `pnpm demo:changes <runDir> --reset` | Replay a real crawl as 4 scripted nights (changes, broken scrape, removal, relist) |
| `pnpm db:migrate` / `db:reset` | Apply SQL migrations / drop and re-create (local) |

## Layout

```
packages/
  core/      Contracts: canonical Unit schema, declarative SourceConfig schema, logger
  http/      Polite HTTP client: per-source rate limit, concurrency cap, retry/backoff, Retry-After
  extract/   Generic engine: extractor interpreter, JSON-LD + spec-table parsing, drivers, normalizer
  db/        Plain-SQL migrations, staging, and the set-based change-detection apply (applyRun)
apps/
  crawler/   CLI + run pipeline (discover → detail → normalize → validate → output → persist)
sources/
  <id>.json              One declarative config per dealer site
  fixtures/<id>/         Saved pages + manifest.json expectations for the contract test
```

Dependencies flow one way: `crawler → extract → http → core`, `crawler → db → core`. Sources
contain no code.

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

## Change detection

Design and trade-offs: [docs/change-detection-plan.md](docs/change-detection-plan.md). In short:
each unit gets per-facet sha256 hashes (details / price / media; availability compared directly),
the run is bulk-staged, and one transaction of set-based SQL emits `NEW`, `RELISTED`,
`PRICE_CHANGED`, `AVAILABILITY_CHANGED`, `DETAILS_CHANGED`, `MEDIA_CHANGED` and `REMOVED`
events, plus `tstzrange` price/availability history and snapshots. Removal only happens on
healthy, complete runs, after a grace period (2 runs).

Demo output from the real Transwest crawl (`pnpm demo:changes`):

```
night 0  real crawl, 356 units         → NEW=356
night 1  scripted changes               → NEW=1 PRICE_CHANGED=4 AVAILABILITY_CHANGED=3
                                          DETAILS_CHANGED=2 MEDIA_CHANGED=2 | 3 missing, within grace
night 2  BROKEN scrape (10 units)       → no changes | removal check skipped (unhealthy)
night 3  vanished units miss 2nd run    → REMOVED=3
night 4  one unit reposted              → RELISTED=1
```

DB integration tests (`packages/db/test`) run when `TEST_DATABASE_URL` points at a throwaway DB.

## Not built yet

Media download/hashing (schema ready: `media_assets`, `unit_media.asset_id IS NULL` as the work
queue), data export, the AWS deployment, and skipping detail fetches for unchanged units.
