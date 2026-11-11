# How the app is put together

A guide to every component: what it does, the key files, and the design calls behind it, with the
reasoning you'd want ready if someone asks "why did you do it this way?"

---

## The big picture

```
                     sources/transwest.json   (data: where things are on ONE site)
                                │
                                ▼
 ┌──────────────── apps/crawler (CLI + run pipeline) ────────────────┐
 │                                                                   │
 │  discover list pages ──► fetch detail pages ──► normalize ──► validate ──► .output/<run>/
 │        (extract: html driver)   (http client)    (extract)   (core zod)    units.ndjson
 │                                                                   │        summary.json
 │                                                     persistRun ───┘
 └───────────────────────────────────────────────────────┼───────────┘
                                                         ▼
                                     packages/db: stage → applyRun (one transaction)
                                                         ▼
                        Postgres: units · unit_events · price/availability history · media
                                                         ▼
                                              export → exports/*.csv / *.ndjson

 Test side:  packages/testkit (mock dealer site)  ◄── scenario tests + `pnpm simulate`
```

Dependencies flow one way: `crawler → extract → http → core` and `crawler → db → core`.
`testkit` only depends on `core`. Sources contain no code.

---

## `packages/core`: shared contracts

The vocabulary every other package speaks. It has no I/O.

| File | What it is |
|---|---|
| `unit.ts` | The **canonical `Unit`** (zod schema): what every dealer's data normalizes into. Identity (`sourceUnitKey`, platform id, stock #, VIN), vehicle fields, `price {amount, msrp, text}`, `availability` enum + raw text, `specs` (free-form label → value), `media[]`, `detailStatus`, `warnings` |
| `source-config.ts` | The **`SourceConfig` schema**: the declarative per-dealer config. Validated, so a typo in a config fails CI, not production |
| `hash.ts` | `canonicalJson` (sorted keys) and `facetHashes(unit)`: a sha256 each for details / price / media |
| `logger.ts` | A tiny JSON-lines logger (stderr), ready for CloudWatch Logs Insights |

**Design calls**
- `price.amount` is `null` for "Contact For Price", **never 0**. `price.text` keeps what the site
  displayed.
- `availability` is a small enum (`available / pending / sold / on_order / unknown`), and
  `availabilityRaw` keeps the dealer's wording, so the mapping can be audited.
- **Facet hashes** leave out noise (`scrapedAt`, warnings, image URL query strings), so "did
  anything change?" is a 32-byte compare.
- `detailStatus` (`ok / failed / skipped`) says whether this observation includes the detail page.
  Change detection depends on it (see db).

---

## `packages/http`: a polite HTTP client

One `HttpClient` per source (i.e. per dealer):
- **Rate limit:** spaces out request *starts* (`requestsPerSecond`, capped at 10 by the schema).
- **Concurrency cap:** a semaphore.
- **Retry:** on 408/425/429/5xx and network errors, with exponential backoff and jitter. It
  honors `Retry-After`; non-retryable statuses (403, 404) fail fast.
- **Stats** (requests, retries, failures, bytes, status mix) feed the run summary.
- **User-Agent:** the default is an honest, self-identifying bot UA. Configs can override it,
  because Transwest's WAF blocks bot UAs. That's an open production question.

---

## `packages/extract`: the generic extraction engine

It turns pages into `Unit`s using only the config.

| File | What it does |
|---|---|
| `drivers/html.ts` | The **html driver**. `discover()` walks paginated list pages; `fetchDetail()` parses a detail page. `parseListPage` / `parseDetailPage` are pure functions, which is what makes offline fixture tests possible |
| `drivers/index.ts` | Driver registry. New platforms (`json-api`, `browser`) plug in here |
| `extract.ts` | The **extractor interpreter**: evaluates a field rule (or an ordered fallback chain) against a scope (card element, page, JSON-LD node, spec table) |
| `page.ts` | `loadPage` (cheerio), `findJsonLd` (handles `@graph`, skips malformed blocks), `parseSpecs` (label/value rows, several layouts) |
| `transforms.ts` | Named transforms: `trim, number, int, price, absUrl, stripQuery, lower, upper, bool, nullIfEmpty` |
| `normalize.ts` | List data + detail data → `Unit`. Detail wins on conflict (recorded as a warning). Applies the availability/condition maps and validates the VIN |

**How a field is described in config**
```jsonc
"stockNumber": [ { "from": "spec", "label": "Stock ID" },   // try first
                 { "from": "jsonld", "path": "sku" } ],     // fallback
"vin": { "attr": "data-form-attributes", "json": "vin", "transforms": ["trim", "upper"] }
```
Extractor kinds are `dom` (selector / attribute / text, optional JSON-inside-attribute), `jsonld`,
`spec` and `const`. Post-processing runs regex → transforms → map.

**Design calls**
- **Drivers are code, sources are data.** A new dealer on a known platform is a JSON file, and
  configs load at runtime, so there's no deploy. Only a new *kind* of site needs code.
- **Fallback chains record disagreements.** Transwest's JSON-LD says every unit is
  `NewCondition`; the spec table wins and the conflict is kept as a warning. A spike in such
  warnings is an early sign of a layout change.
- **Pagination stop rules:** no cards, *no new keys* (catches sites that silently serve page 1
  for any page number), or the site's own total reached.
- **Media identity ignores query strings**, so a re-signed image URL is the same photo.

---

## `sources/`: dealer configs and fixtures

- `transwest.json` (config v3): start URLs (trucks + trailers), `?page=N` pagination, card
  selector, list fields (from `data-*` attributes and the JSON blob), detail fields (spec table →
  JSON-LD), media rules, identity priority `[platformId, stockNumber, vin]`, availability map
  ("Rental", "Available for Lease" → available), and `hashIgnoreSpecs` (["List Price", "Status"]).
  Those two spec rows repeat price and availability, so a price cut doesn't also fire
  DETAILS_CHANGED.
- `fixtures/transwest/`: one saved list page and one saved detail page, plus `manifest.json`
  expectations. The **contract test** runs every config against its fixtures offline. When a site
  changes layout, re-capture the fixtures, watch the test go red, fix the config and bump its
  version.

Onboarding a dealer:
1. Fingerprint the site.
2. Write the config and iterate with `pnpm probe`.
3. Capture fixtures with `pnpm fixtures:capture`.
4. Run `pnpm test`.
5. Ship the config.

---

## `apps/crawler`: CLI and run pipeline

| File | What it does |
|---|---|
| `run.ts` | `crawlSource(config)`: discover → detail (bounded concurrency) → normalize → validate → write `units.ndjson`, `errors.ndjson`, `summary.json`. A failed detail page **degrades** the unit (`detailStatus: failed`) instead of dropping it. Takes an injectable clock (`now`) for simulations |
| `summary.ts` | The **run health report**: coverage (discovered vs the site's own total), fill rates per field, invalid / detail-failure rates, warning buckets, HTTP stats. **Healthy** = coverage ≥ 95%, invalid ≤ 2%, detail failures ≤ 5%, no list failures, not partial |
| `persist.ts` | `persistRun`: register the source, record the run, stage units with facet hashes, call `applyRun`. Used by live crawls, imports and the simulation alike |
| `config-store.ts` | `FileConfigStore` behind a `ConfigStore` interface (S3 or DynamoDB in production) |
| `simulate.ts` | The simulated week on real inventory (see testkit) and the generated `exports/README.md` |
| `export.ts` | DB → CSV/NDJSON: units, events, price and availability history, media, runs |
| `cli.ts` | All commands (below). One dealer failing never stops the others |

**Commands**

| `pnpm …` | Purpose |
|---|---|
| `crawl <id\|all>` | Live crawl (persists when `DATABASE_URL` is set). Flags: `--limit`, `--max-pages`, `--no-detail`, `--no-persist`, `--base-url` |
| `probe <id>` | Quick live check while writing a config; writes nothing |
| `sources:list` / `sources:validate` | Validate all configs (the CI gate) |
| `fixtures:capture <id>` | Save fixture pages |
| `db:migrate` / `db:reset` / `db:import <runDir>` | Database upkeep, and persisting a saved run |
| `simulate --reset` | Simulated week → `exports/` |
| `export [id] --out DIR` | Export any DB |
| `test` / `test:scenarios [-t name]` | Unit + contract tests / end-to-end scenarios |
| `mock:serve` | Run the mock dealer site standalone |

---

## `packages/db`: schema and change detection

### Schema (`migrations/0001_init.sql`, `0002_details_doc.sql`)

| Table | Role |
|---|---|
| `dealers`, `sources` | Who and where. `sources.config` stores the config snapshot; `removal_grace_runs` (default 2) |
| `crawl_runs` | One row per run: `healthy`, `partial`, the summary, `applied_at` (idempotency guard), `apply_stats` |
| `staged_units` | UNLOGGED landing table: one row per unit per run, with facet hashes |
| `units` | **Current state**: one row per unit ever seen. Typed columns for querying, the full record in `data` jsonb, the three hashes, `status` active/removed, `missed_runs`, first/last seen |
| `unit_events` | **Append-only change log**: `NEW, PRICE_CHANGED, AVAILABILITY_CHANGED, DETAILS_CHANGED, MEDIA_CHANGED, REMOVED, RELISTED`, with a field-level `changes` jsonb |
| `unit_price_history`, `unit_availability_history` | Time ranges (`tstzrange`) with **exclusion constraints**, so overlapping or doubled-up open ranges are impossible. Answers "what was the price on March 3rd?" |
| `unit_snapshots` | Full record, written only when details change |
| `unit_media`, `media_assets` | Photo listings per unit (with `removed_at`); `asset_id IS NULL` is the future download queue |

`jsonb_diff()` and `details_doc()` (SQL functions) produce the field-level diffs, e.g.
`{"spec:Exterior Color": {"old": "Blue", "new": "Red"}}`.

### `applyRun(runId)`: one transaction, set-based

```
guard (exists, succeeded, not yet applied, not older than an applied run)
→ classify: staged ⋈ current state into temp table m
→ degraded rows (detail failed/skipped): carry stored details + media forward
→ NEW → RELISTED → snapshots + open ranges
→ PRICE / AVAILABILITY (close range, open range, event: one statement each)
→ DETAILS (jsonb_diff) → MEDIA (added/removed/count) → unit_media upkeep
→ touch every seen unit (last_seen, missed_runs = 0)
→ ONLY IF healthy AND not partial: missed_runs + 1; at grace → REMOVED (close ranges)
→ stats, applied_at, clear staging
```

**Design calls worth defending**
- **Why not brute force?** Loading every unit and deep-comparing in the app is N round-trips and
  full-record compares per dealer, with diff logic outside the transaction that writes it. Here
  it's a hash join with ~10 set-based statements, and work scales with the number of units that
  *changed*.
- **Why not triggers?** Triggers have no run context (healthy? partial?), and a removal isn't an
  UPDATE.
- **Why plain SQL and `pg`, not an ORM?** The core logic is CTEs, ranges and exclusion constraints.
  An ORM would hide exactly the parts that matter.
- **Deferred constraints gotcha:** sibling data-modifying CTEs share one snapshot, so
  "close the old range + open the new one" in a single statement trips an immediate exclusion
  constraint. The constraints are `DEFERRABLE INITIALLY DEFERRED`: checked at commit, and still
  enforced.
- **Grace period:** a unit has to be missing from 2 healthy runs before it's removed, which
  absorbs flaky pagination and brief delistings.
- **Degraded observations:** only diff the facets the run actually saw. Without that, one 500 on a
  detail page reads as "every photo deleted". The scenario suite caught this bug.
- **Idempotent and ordered:** re-applying a run is a no-op, and an older run can't be applied
  after a newer one.

---

## `packages/testkit`: the mock dealer site

A real HTTP server on localhost that **renders Transwest's markup** from an in-memory inventory.

- **Templates** (`transwest-templates.ts`) reproduce exactly what the config reads: card
  `data-*` attributes, the `data-form-attributes` JSON, `wire:key`, the "1 - 19 / 332" total,
  Vehicle JSON-LD (including the real `NewCondition` bug), and the spec list. They also carry the
  real quirks: the card's price field shows "Sold" or "Coming Soon", and there's no List Price row
  when a unit is unpriced.
- **Mutations:** `site.update(stock, patch)`, `remove`, `add(unit, 'top')`.
- **Faults:** `failListPage(n)`, `failDetail(stock, {status, times})`, `layout = 'redesign'`,
  `outOfRangePage: 'first-page'`, and nightly image-URL re-signing.
- **Request log:** `site.hits(/regex/)`, for asserting what the crawler fetched.
- **`mockUnitFromUnit()`** seeds the mock from a real crawl, using the same paths, ids, specs and
  photos.

Using a real HTTP server (not a mocked `fetch`) means the whole stack is exercised: rate limiting,
retries, redirects, URL resolution.

---

## Testing layers

| Layer | Where | Needs a DB? | What it proves |
|---|---|---|---|
| Unit | `core/test` (hashing), `http/test` (retry/rate), `extract/test` (extractors) | no | Building blocks behave |
| Contract | `crawler/test/sources.test.ts` | no | Every config parses its saved real pages, plus a golden snapshot |
| DB integration | `db/test/apply.test.ts` | yes | Every event type, grace period, unhealthy-run safety, point-in-time price, idempotency |
| **Scenarios** | `crawler/test/scenarios/*.test.ts` (19) | yes | The real pipeline reacts correctly to each kind of overnight change and each kind of failure |
| Simulation | `pnpm simulate` | yes | Real inventory, a scripted week; night-0 fidelity check (356/356) |

The scenario harness (`scenarios/harness.ts`) gives each scenario its own mock site, source id and
simulated clock, so they're isolated and can be run one at a time:
`pnpm test:scenarios -t "price cut"`.

The 10 change scenarios: first crawl; noise-only re-crawl; price cut; price hidden/revealed;
pending → sold; spec + mileage edit; photo add/remove/reorder; new listing shifting pagination;
missing → grace → removed → relisted; stock number re-keyed.

The 9 resilience scenarios: list page down all night; transient 429/503; detail page down; new
unit with its detail page down (backfill); `--no-detail` run; site redesign; partial runs;
pagination stop rules; User-Agent.

---

## `exports/`: the data deliverable

- **Top level:** a simulated week on the real 356-unit inventory, run through the full pipeline.
  It covers every event type, a flaky night with no false changes, and a broken night that
  removes nothing. `README.md` explains each night.
- **`live-crawl/`:** raw output of the real crawl that seeded it.
- **`real-crawl-pair/`:** two *real* crawls 4.5 hours apart, diffed: 2 new, 2 missing,
  4 repricings, 1 sold → available. It also shows config-driven noise (8 rentals re-mapped).

---

## Known limitations (good to own up front)

- Only the `html` driver exists. `json-api` and `browser` are designed, not built.
- Media is URLs only (no download or dedupe yet). AWS is design-only.
- Staging uses multi-row INSERTs. `COPY` from S3 is the production upgrade.
- Every unit's detail page is fetched every night. Skipping unchanged units is designed.
- A config version bump can emit normalization-driven events (seen in the real crawl pair).
- Cross-dealer duplicate resolution (a canonical vehicle by VIN) is design-only.
- Transwest is crawled with a browser UA. That needs a consent / allow-listing decision.
