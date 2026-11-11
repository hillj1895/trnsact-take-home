# Change detection — plan of attack

Status: **draft for review**. Schema: [`packages/db/migrations/0001_init.sql`](../packages/db/migrations/0001_init.sql)
(applied and constraint-tested against a local Postgres 14).

## The problem

Each nightly run produces the full set of units a dealer currently lists. We need to record, per
unit, what changed since the last run: **new**, **removed/sold**, **price**, **availability**,
**listing details**, **media**. We also need to answer history questions ("price on March 3rd?",
"days on lot", "how often does this dealer cut prices?").

## Options considered

| Approach | How | Verdict |
|---|---|---|
| **A. Brute force in the app** | Load every current unit for the dealer, deep-compare to incoming in TS, write diffs row by row | Correct and simple at 356 units. At scale it's N round-trips and full-record compares per dealer per night, and the diff logic lives outside the transaction that writes it |
| **B. DB triggers (CDC)** | `UPDATE units` fires a trigger that writes `unit_events` | Can't forget to log, but triggers have no run context (healthy? partial?), removals aren't updates, and business logic hidden in triggers is hard to test |
| **C. Hash-gated, set-based apply** ✅ | Bulk-load the run into a staging table, then one transaction of set-based SQL compares hashes and writes events and history | Chosen. Details below |
| D. Native temporal tables / event sourcing | `temporal_tables` extension, or rebuild state from an event stream | Overkill here. We get the useful part (time-ranged history) with plain `tstzrange` + exclusion constraints |

## Chosen design: hash-gated, set-based apply

### 1. Hash per *facet*, not per record

When it normalizes a unit, the crawler computes a sha256 of the canonical JSON (sorted keys) for
each facet. Each facet changes for different reasons, and each maps to an event type:

| Facet | Contents | Event |
|---|---|---|
| `price_hash` | `{amount, msrp, text}` | `PRICE_CHANGED` |
| `availability` | enum (compared directly, no hash needed) | `AVAILABILITY_CHANGED` |
| `media_hash` | ordered list of media keys (URL minus query string) | `MEDIA_CHANGED` |
| `details_hash` | everything else that describes the unit: identity, year/make/model, mileage/hours, location, category, condition, specs, description | `DETAILS_CHANGED` |

**Excluded from every hash:** `scrapedAt`, `warnings`, signed or resized URL query strings, and
field order. These change every night without anything real changing. Including them would turn
every run into "everything changed".

Because of this, "did anything change?" is a 32-byte compare on an indexed join. The full JSON is
only diffed for the few rows whose `details_hash` moved, and that diff (`jsonb_diff()`) produces the
field-level payload for the event.

### 2. Per-run flow

```
crawl ──► units.ndjson (S3) ──► COPY into staged_units (UNLOGGED) ──► apply_run(run_id) ──► crawl_runs.applied_at
```

`apply_run` runs in **one transaction** per run. All steps join `staged_units s` to `units u` on
`(source_id, source_unit_key)`, which is unique and indexed.

1. **Guard.** The run must exist, have `status = succeeded`, and have `applied_at IS NULL`. This
   makes apply idempotent: a retried job is a no-op.
2. **NEW.** Staged rows with no `units` row: insert the unit, a snapshot, open price and
   availability ranges, and a `NEW` event.
3. **RELISTED.** Staged rows whose unit is `status = removed`: reactivate and emit `RELISTED`.
   Dealers do pull a unit and repost it.
4. **CHANGED.** Matched rows where any facet differs:
   - price: close the open `unit_price_history` range at the run time, open a new one, and emit
     `PRICE_CHANGED {old, new}`
   - availability: same pattern on `unit_availability_history`, emitting `AVAILABILITY_CHANGED`
   - details: insert a `unit_snapshots` row and emit `DETAILS_CHANGED` with `jsonb_diff(old, new)`
   - media: upsert `unit_media`, set `removed_at` on keys that disappeared, and emit
     `MEDIA_CHANGED {added, removed, reordered}`
5. **TOUCH.** Every staged unit gets `last_seen_*` updated, `missed_runs = 0` and its current
   columns refreshed. One `UPDATE … FROM staged_units`.
6. **MISSING.** This step runs **only if the run is healthy and not partial.** Active units for
   the source that aren't in staging get `missed_runs + 1`. Once that reaches
   `sources.removal_grace_runs` (default 2), set `status = removed`, close their open ranges and
   emit `REMOVED`. The event records the last known availability, so "sold, then removed" and
   "vanished while still available" can be told apart.
7. Record `apply_stats` (count per event type) on the run, set `applied_at`, and delete the staged
   rows.

Sketch of the core of step 4. Every facet follows the same pattern:

```sql
WITH changed AS (
  SELECT u.id, u.price_amount AS old_amount, (s.data->'price'->>'amount')::numeric AS new_amount,
         u.price_text AS old_text, s.data->'price'->>'text' AS new_text
  FROM staged_units s
  JOIN units u ON u.source_id = $source AND u.source_unit_key = s.source_unit_key
  WHERE s.run_id = $run AND u.price_hash <> s.price_hash
),
closed AS (
  UPDATE unit_price_history h SET valid = tstzrange(lower(h.valid), $run_at), to_run_id = $run
  FROM changed c WHERE h.unit_id = c.id AND upper_inf(h.valid)
  RETURNING h.unit_id
),
opened AS (
  INSERT INTO unit_price_history (unit_id, amount, price_text, valid, from_run_id)
  SELECT id, new_amount, new_text, tstzrange($run_at, NULL), $run FROM changed
)
INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
SELECT id, $run, 'PRICE_CHANGED', $run_at,
       jsonb_build_object('amount', jsonb_build_object('old', old_amount, 'new', new_amount),
                          'text',   jsonb_build_object('old', old_text,   'new', new_text))
FROM changed;
```

> **Gotcha found while testing the sketch:** sibling data-modifying CTEs share a snapshot. With
> an *immediate* exclusion constraint, the INSERT of the new open range sees the old range still
> open, and the statement fails. The history constraints are therefore `DEFERRABLE INITIALLY
> DEFERRED`: they're checked at commit, so close+open can share one statement, and a genuine
> overlap still fails the transaction. (Verified on Postgres 14: swap succeeds,
> `valid @> '2026-02-15'` returns the old price, and an injected overlap is rejected at COMMIT.)

### 3. Why this holds up at scale

- **Work is proportional to change, not inventory.** Most units don't change on a given night. The
  join is index-on-index, hash compares are cheap, and history and snapshot rows are written only
  for the rows that moved. Storage grows with the amount of change, not with units × nights.
- **Bulk in, bulk out.** One `COPY` and roughly 7 set-based statements per dealer, instead of one
  round-trip per unit. Thousands of dealers means thousands of small, independent transactions,
  which parallelize well and never lock each other (each dealer only touches its own rows).
- **History is queryable without replay.** `valid @> timestamp` against a GiST index answers
  point-in-time questions. The exclusion constraint guarantees the history can never have overlaps
  or two open ranges, whatever bug the app has.
- **Run-level safety is built into the data model.** The `healthy`/`partial` flags gate removal.
  The 403 run we hit earlier (0 units) would apply NEW and CHANGED as no-ops and skip MISSING
  entirely, instead of marking 356 units removed.
- **The crawl gets cheaper too.** Before fetching detail pages, the crawler can read current
  `price_hash` and `availability` from the list-card data. It then fetches detail pages only for
  new units, units whose list-level facets changed, and a rolling refresh (for example 1/7 of units
  each night). On Transwest that cuts about 356 detail requests to about 60 a night.

### 4. Semantics worth agreeing on

- **"Sold" vs "removed".** Transwest shows `Sold` explicitly and keeps sold units listed (47 last
  run). Sold is an availability change. Removed means gone from the site. Most dealers will only
  give us the second, so downstream should treat `REMOVED` while available as "probably sold,
  unconfirmed".
- **Grace period.** A unit has to be missing from 2 healthy runs before it's `REMOVED`. This avoids
  churn from flaky pagination or brief delistings. It's configurable per source.
- **Identity changes.** If a dealer changes a stock number, `source_unit_key` (the platform id) is
  stable for Transwest. For sources keyed by stock number, a re-key looks like REMOVED plus NEW.
  Planned mitigation: on NEW, look for a recently removed unit at the same dealer with the same
  valid VIN and link the two (a `RELISTED` with `previous_unit_id`).
- **Mileage creep** on demo units shows up as `DETAILS_CHANGED`. That's fine, but we may want a
  dedicated facet if usage changes turn out to be noisy.
- **Event time** is when we observed the change (run start), not when it actually happened. The
  real change time is unknowable to within ±1 run interval.

## Implementation steps (after sign-off)

1. `packages/db`: migration runner (plain SQL files, applied in order), a `pg` client, and
   `docker-compose.yml` for local Postgres.
2. `core`: `facetHashes(unit)` with canonical JSON plus unit tests (same unit → same hash;
   `scrapedAt`, warnings and signed URLs → no change).
3. `db`: `stageRun()` (COPY from NDJSON), `applyRun()` as a SQL function or one transaction,
   plus integration tests against Postgres covering each event type.
4. `crawler`: run lifecycle (`crawl_runs` insert → crawl → stage → apply) and a `--replay
   <runId> --mutate` mode that re-applies a stored run with scripted changes, to demo every event
   type without waiting a night.
5. `reporter`: `report --run <id>` (events grouped by type) and `export` (units, events, history
   → JSON/CSV) for the deliverable.

## Questions for review

1. **Plain SQL migrations vs Drizzle.** Earlier I suggested Drizzle. Now that the core logic is
   set-based SQL (CTEs, ranges, exclusion constraints), I'd lean toward plain `.sql` migrations and
   `pg`, typing results with zod/`Unit`. Drizzle adds little here. OK to switch?
2. **`apply_run` as a stored plpgsql function, or SQL statements run from TS in one transaction?**
   A function is atomic, fast and callable from anywhere (Lambda, psql). TS is easier to test
   step by step and to log. Leaning TS.
3. **Grace period default:** 2 runs, or 1 (removed the first night it's missing)?
4. Should media download (S3 + content hashing) be in scope for the take-home, or just designed
   here? The schema already supports it (`media_assets`, `asset_id IS NULL` work queue).
