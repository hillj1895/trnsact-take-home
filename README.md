# Dealer Inventory Scraper

Take-home submission by Joe Hill: a nightly scraper for commercial truck dealer inventory, built
for one dealer ([Transwest](https://www.transwest.com)) and designed to scale to thousands.

## Deliverables

| Deliverable                   | Where                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code**                      | This repo: [`packages/`](packages/), [`apps/crawler/`](apps/crawler/), dealer configs in [`sources/`](sources/). Setup and commands are under [Technical documentation](#technical-documentation) below                                                                                            |
| **Database schema**           | [`packages/db/migrations/0001_init.sql`](packages/db/migrations/0001_init.sql) (+ [`0002_details_doc.sql`](packages/db/migrations/0002_details_doc.sql))                                                                                                                                           |
| **Export of the stored data** | [`exports/`](exports/), starting at [`exports/README.md`](exports/README.md): units, change events, price and availability history, media and runs, as CSV + NDJSON. Real inventory through a simulated week, plus a real two-crawl diff in [`exports/real-crawl-pair/`](exports/real-crawl-pair/) |
| **One-page write-up**         | [Below](#write-up): how it was built and why, scaling to thousands of dealers, questions I'd ask                                                                                                                                                                                                   |
| **Time taken**                | ~3hrs                                                                                                                                                                                                                                                                                              |
| **How AI was used**           | [Below](#how-i-used-ai), and every prompt in [`CLAUDE_QUERIES.txt`](CLAUDE_QUERIES.txt)                                                                                                                                                                                                            |

## Write-up

### How I built it and why

I picked Transwest, a truck dealer with about 356 units listed. Their site is server-rendered, which made life easier: everything I needed was in the HTML, either on the listing cards or in the structured data on each detail page.

I didn't want to write a one-off scraper, so I split it into two parts. The code knows how to read a kind of website. Each dealer then gets a small JSON config that says where to find things on its site. Adding a dealer on a platform we already support means writing a config, not code, and no deploy.

For tracking changes, I didn't want to compare every record field by field each night. Instead, each unit gets a fingerprint for its price, its details and its photos. Each run gets loaded into Postgres, and a single SQL transaction works out what's new, what changed and what disappeared, then logs each change with before and after values. Price and availability history are kept as date ranges, so you can ask what a truck cost on any given day.

The thing I cared most about was not crying wolf. If a scrape breaks halfway through, it shouldn't look like the dealer sold their whole lot overnight. Every run grades its own health, and units are only marked removed after they've been missing from two good runs in a row.

Since I couldn't wait a week to see real inventory change, I built a fake dealer website that looks like Transwest's. Tests can edit it or break it between "nights". That turned up a real bug: a detail page that failed to load looked like every photo on the unit had been deleted. The data export comes from that same setup: the real inventory, run through a scripted week of changes. I also included a diff of two real crawls a few hours apart, which already caught genuine price changes and a sold truck coming back on the market.

### Scaling to thousands of dealers

On AWS I'd queue one job per dealer each night, run the crawls on Fargate containers, keep the raw pages in S3, and update Postgres per dealer. The compute is cheap, probably under $10 a month. The real costs are people's time and sites that fight back.

A lot of dealers run on the same few website platforms, so one config can cover many of them. The rest is a long tail, where I'd prefer a dealer's own feed, then plain HTML, and use a headless browser only as a last resort. When a site changes its layout, the health checks catch it (fields going missing, unit counts dropping) and nothing gets removed until someone fixes the config. Duplicates across dealer groups and marketplaces would be matched by VIN. Photos would be downloaded once, deduped and served from S3. Monitoring comes almost for free from the per-run health summaries.

### Questions I'd ask

- Do we have permission from dealers? Transwest's firewall blocks obvious bots, so I used a browser-like user agent. I'd rather be allow-listed than sneak around.
- Who uses this data, and how fresh does it need to be?
- Most dealers never say "sold", they just take the listing down. Is "probably sold" good enough?
- Is the same truck on two sites one vehicle or two?
- Are there feeds we could use instead of scraping?

### Time taken

About 3 hours.

### How I used AI

I used Claude Code as a pair programmer throughout, and every prompt is logged verbatim in [`CLAUDE_QUERIES.txt`](CLAUDE_QUERIES.txt). It did a lot of the research and most of the typing. I set the direction: making it generic, pushing for a database-native way to track changes, asking for the fake-site test setup, and deciding what to leave as design only. It needed checking along the way. It misjudged how the site rendered, which a quick look at the raw HTML cleared up, and it wrote some SQL that broke a database constraint, which the tests caught.

---

# Technical documentation

Deeper dives: [how the components fit together](docs/components.md) ·
[change detection design](docs/change-detection-plan.md) · [data export](exports/README.md).

## Quick start

```bash
corepack enable          # provides pnpm 9 (pinned in package.json)
pnpm install
pnpm test                # unit tests + offline fixture contract tests

cp .env.example .env     # DATABASE_URL for the compose Postgres
pnpm db:up               # Postgres 16 in Docker (or point DATABASE_URL at any PG 14+)
pnpm crawl transwest     # live crawl → .output/transwest/<runId>/ → persisted + change-detected

# A simulated week on the real inventory → exports/ (wipes the DB):
pnpm simulate --reset
```

Useful flags: `--max-pages 1 --limit 5` (quick partial run), `--no-detail` (list pages only),
`--no-persist` (skip the DB), `--base-url URL` (same config, another host, e.g. the mock dealer).

| Command                                  | What it does                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm crawl <id\|all>`                   | Crawl one source or every enabled source; writes `units.ndjson`, `errors.ndjson`, `summary.json`            |
| `pnpm probe <id> [--limit N]`            | Live check while authoring a config — prints normalized units, writes nothing                               |
| `pnpm sources:list` / `sources:validate` | List / validate all source configs (validate exits non-zero → CI gate)                                      |
| `pnpm fixtures:capture <id>`             | Save list page 1 + one detail page as offline test fixtures                                                 |
| `pnpm db:import <runDir>`                | Persist a saved run directory into the DB                                                                   |
| `pnpm simulate [runDir] --reset`         | Seed the mock dealer with a real crawl, run a scripted week through the full pipeline, export to `exports/` |
| `pnpm export [sourceId] [--out DIR]`     | Export any inventory DB (units, events, price/availability history, media, runs) as CSV + NDJSON            |
| `pnpm db:migrate` / `db:reset`           | Apply SQL migrations / drop and re-create (local)                                                           |
| `pnpm test:scenarios [-t name]`          | End-to-end change scenarios against the mock dealer (needs `TEST_DATABASE_URL`)                             |
| `pnpm mock:serve [port]`                 | Run the mock dealer site standalone (default :4010)                                                         |

## Layout

```
packages/
  core/      Contracts: canonical Unit schema, declarative SourceConfig schema, logger
  http/      Polite HTTP client: per-source rate limit, concurrency cap, retry/backoff, Retry-After
  extract/   Generic engine: extractor interpreter, JSON-LD + spec-table parsing, drivers, normalizer
  db/        Plain-SQL migrations, staging, and the set-based change-detection apply (applyRun)
  testkit/   Mock dealer website (Transwest-shaped HTML, mutable inventory, fault injection)
apps/
  crawler/   CLI + run pipeline (discover → detail → normalize → validate → output → persist)
sources/
  <id>.json              One declarative config per dealer site
  fixtures/<id>/         Saved pages + manifest.json expectations for the contract test
```

Dependencies flow one way: `crawler → extract → http → core`, `crawler → db → core`. Sources
contain no code. `testkit` is a dev-only dependency of the crawler's tests.

## How the generic system works

Two halves:

- **Drivers (code)** know how to talk to a _kind_ of site. Today: `html` (server-rendered list
  pages + optional detail pages). Planned: `json-api` (sites backed by Algolia / a vendor search
  API), `browser` (Playwright, for client-rendered SPAs — the expensive last resort).
- **Source configs (data)** say where things are on _one_ site: start URLs, pagination, card
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
Downstream change detection must only mark units _removed_ after a healthy run — a broken
scrape must never look like a dealer selling its whole lot.

Failure handling: a failed list page marks the run unhealthy; a failed detail page degrades
the unit to list-only data (still proves existence, price, availability) rather than dropping it.

## Platform survey (Nov 2026)

| Dealer                                 | Platform / rendering                                               | Implication                        |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Transwest                              | Agency build, Laravel Livewire, SSR; data-\* attrs + JSON-LD       | `html` driver                      |
| Fyda Freightliner, Worldwide Equipment | **Dealer Spike** (shared `/inventory/v1/`, `--xNewInventory` URLs) | one config template → many dealers |
| Premier Truck Group                    | Next.js + RideMotive inventory API                                 | `json-api` driver candidate        |
| Rush Truck Centers                     | Custom, JSON-LD present                                            | `html` driver                      |
| MHC Kenworth                           | Sitecore                                                           | `html` driver                      |

Takeaway: a long tail of custom sites, but a meaningful share sits on a handful of dealer
platforms, where one config template covers every dealer on that platform.

## Change detection

Design and trade-offs: [docs/change-detection-plan.md](docs/change-detection-plan.md). In short:
each unit gets per-facet sha256 hashes (details / price / media; availability compared directly),
the run is bulk-staged, and one transaction of set-based SQL emits `NEW`, `RELISTED`,
`PRICE_CHANGED`, `AVAILABILITY_CHANGED`, `DETAILS_CHANGED`, `MEDIA_CHANGED` and `REMOVED`
events, plus `tstzrange` price/availability history and snapshots. Removal only happens on
healthy, complete runs, after a grace period (2 runs).

A simulated week on the real inventory (`pnpm simulate`; full results in
[exports/README.md](exports/README.md)) produces every event type, including a broken-scrape night
that removes nothing and a flaky night with no false changes.

DB integration tests (`packages/db/test`) run when `TEST_DATABASE_URL` points at a throwaway DB.

## Testing inventory changes without waiting a night

The **scenario suite** drives the _whole_ pipeline (HTTP → extract → normalize → persist → apply)
against a fake dealer website, so each kind of overnight change is a test that runs in about 100 ms.

- **`@trnsact/testkit` `MockDealer`**: a localhost server rendering Transwest-shaped markup (card
  `data-*` attributes, the `data-form-attributes` JSON, `wire:key`, the "1 - 10 / 25" total,
  Vehicle JSON-LD with the real `NewCondition` bug, the spec list) from an in-memory inventory.
  Tests mutate it (`site.update('MK0001', { price: 58_000 })`, `remove`, `add`) and inject
  faults (`failListPage(2)`, `failDetail('MK0012', { status: 503, times: 2 })`,
  `layout = 'redesign'`, a server that repeats page 1 for out-of-range pages). Image URLs
  are re-signed every night, like the real CDN.
- **The real config**: scenarios load `sources/transwest.json` and swap only `baseUrl` and the
  rate limit, so they exercise the production extraction rules, not a test copy.
- **Simulated clock**: `crawlSource({ now })`. Each `s.night()` runs one day later, so price
  history and point-in-time queries behave as they would in production.
- **Isolation**: every scenario gets its own site, source id and output dir, so you can run any
  one alone with `pnpm test:scenarios -t "price cut"`.

```ts
scenario("price cut → PRICE_CHANGED only", async (s) => {
  await s.night(); // baseline
  s.site.update("MK0001", { price: 58_000 }); // dealer edits the listing
  const night = await s.night(); // crawl + apply, one day later
  expect(night.types).toEqual({ MK0001: ["PRICE_CHANGED"] });
});
```

| Inventory changes (`inventory-changes.test.ts`)        | Resilience (`resilience.test.ts`)                                |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| first crawl → all `NEW`, healthy                       | list page 500s all night → unhealthy, nothing removed (3 nights) |
| identical re-crawl, re-signed images → no events       | transient 429/503 → retried, no events                           |
| price cut → `PRICE_CHANGED` only, point-in-time price  | detail page down → list data kept, **no phantom changes**        |
| price hidden / revealed (`null`, not $0)               | new unit with detail down → backfilled quietly next night        |
| available → pending → sold, with history ranges        | `--no-detail` run → price/availability still tracked             |
| spec edit + mileage → field-level `DETAILS_CHANGED`    | site redesign (0 cards) → unhealthy, no mass removal             |
| photo added / removed / reordered → `MEDIA_CHANGED`    | `--limit` partial runs never remove                              |
| new listing shifts pagination → only `NEW`             | pagination stops at the site total, no duplicates                |
| missing → grace → `REMOVED` → `RELISTED`               | configured User-Agent on every request                           |
| stock # re-keyed, same platform id → `DETAILS_CHANGED` |                                                                  |

**Bug this caught:** a failed detail page used to stage the unit with empty specs and media.
The next apply then reported `DETAILS_CHANGED` and "all photos removed", and wiped stored
media. Units now carry `detailStatus` (`ok` / `failed` / `skipped`). `applyRun` diffs only the
facets a run actually observed, and treats a unit's first complete observation as a backfill,
not a change.

```bash
createdb inventory_test            # any throwaway PG 14+ database
echo 'TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/inventory_test' >> .env
pnpm test:scenarios                # ~3s; skipped (not failed) without TEST_DATABASE_URL
```

### The data export uses the same machinery

`pnpm simulate --reset` seeds the mock dealer with **every unit from the latest real crawl**: the
same URL paths, platform ids, specs and photo asset ids. It then runs a scripted week (price cuts,
pending/sold, photo edits, take-downs and a relist, a flaky night and a broken night) through the
full pipeline, and exports the database to [`exports/`](exports/). On night 0 it checks that
crawling the mock reproduces the real crawl, unit for unit. The results and fidelity figures are in
[exports/README.md](exports/README.md).

## Not built yet

Deliberately design-only (covered in the write-up): media download and hashing (the schema is
ready: `media_assets`, with `unit_media.asset_id IS NULL` as the work queue), the AWS deployment,
and skipping detail fetches for unchanged units.
