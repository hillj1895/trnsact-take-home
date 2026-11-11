-- =============================================================================
-- 0001_init — inventory store with run-over-run change tracking (PostgreSQL 14+)
--
-- Model, in one breath:
--   * `units` holds the CURRENT state of every unit we've ever seen (one row per
--     source + source_unit_key), plus per-facet content hashes.
--   * Each crawl run bulk-loads into `staged_units`; one set-based SQL apply
--     (see docs/change-detection-plan.md) diffs staged vs current by hash and
--     writes append-only history: `unit_events`, `unit_snapshots`, and
--     time-ranged `unit_price_history` / `unit_availability_history`.
--   * Nothing is ever deleted: removed units flip status, history stays.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints on (unit_id, tstzrange)

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE availability AS ENUM ('available', 'pending', 'sold', 'on_order', 'unknown');
CREATE TYPE unit_condition AS ENUM ('new', 'used', 'unknown');
CREATE TYPE unit_status AS ENUM ('active', 'removed');
CREATE TYPE run_status AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE media_kind AS ENUM ('image', 'video', 'document');
CREATE TYPE unit_event_type AS ENUM (
  'NEW',                  -- first time we've seen this unit
  'REMOVED',              -- missing from N consecutive healthy runs
  'RELISTED',             -- seen again after REMOVED
  'PRICE_CHANGED',        -- amount, msrp or displayed price text changed
  'AVAILABILITY_CHANGED', -- e.g. available -> pending -> sold
  'DETAILS_CHANGED',      -- any listing detail / spec changed (field-level diff in payload)
  'MEDIA_CHANGED'         -- photos/videos/documents added, removed or reordered
);

-- -----------------------------------------------------------------------------
-- Who / where
-- -----------------------------------------------------------------------------
CREATE TABLE dealers (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One crawlable inventory source (a dealer may have several: website, feed, …).
-- `config` is the declarative SourceConfig — this table can replace /sources/*.json
-- as the ConfigStore, so onboarding a dealer is an INSERT, not a deploy.
CREATE TABLE sources (
  id              text PRIMARY KEY,
  dealer_id       text NOT NULL REFERENCES dealers(id),
  driver          text NOT NULL,
  base_url        text NOT NULL,
  config          jsonb NOT NULL,
  config_version  int  NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  -- consecutive healthy runs a unit may be missing before it is REMOVED
  removal_grace_runs int NOT NULL DEFAULT 2 CHECK (removal_grace_runs >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Runs
-- -----------------------------------------------------------------------------
CREATE TABLE crawl_runs (
  id              text PRIMARY KEY,                  -- e.g. transwest-2026-11-10T23-47-02-882Z
  source_id       text NOT NULL REFERENCES sources(id),
  config_version  int  NOT NULL,
  status          run_status NOT NULL DEFAULT 'running',
  healthy         boolean,                           -- from summary.health; gates removal detection
  partial         boolean NOT NULL DEFAULT false,    -- --limit / --max-pages runs never remove units
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  applied_at      timestamptz,                       -- set once the diff is applied (idempotency guard)
  summary         jsonb,                             -- full RunSummary (counts, fill rates, http stats)
  apply_stats     jsonb                              -- counts of each event type produced
);
CREATE INDEX crawl_runs_source_started_idx ON crawl_runs (source_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- Staging: one row per unit observed in a run. UNLOGGED = no WAL, fast bulk COPY;
-- it's disposable (rebuildable from the run's units.ndjson in S3).
-- Rows are deleted after a successful apply.
-- -----------------------------------------------------------------------------
CREATE UNLOGGED TABLE staged_units (
  run_id           text NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  source_unit_key  text NOT NULL,
  data             jsonb NOT NULL,          -- full normalized Unit
  details_hash     bytea NOT NULL,          -- sha256 of canonical details facet
  price_hash       bytea NOT NULL,          -- sha256 of {amount, msrp, text}
  media_hash       bytea NOT NULL,          -- sha256 of ordered media keys
  availability     availability NOT NULL,
  PRIMARY KEY (run_id, source_unit_key)
);

-- -----------------------------------------------------------------------------
-- Current state
-- -----------------------------------------------------------------------------
CREATE TABLE units (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        text NOT NULL REFERENCES sources(id),
  source_unit_key  text NOT NULL,           -- platform id > stock # > VIN, per source config
  UNIQUE (source_id, source_unit_key),

  -- identity / cross-source matching
  vin              text,
  stock_number     text,
  platform_id      text,
  listing_url      text NOT NULL,

  -- hot, queryable current fields (the full record lives in `data`)
  year             smallint,
  make             text,
  model            text,
  category         text,
  condition        unit_condition NOT NULL DEFAULT 'unknown',
  mileage          numeric(12, 1),
  hours            numeric(12, 1),
  location         text,
  price_amount     numeric(12, 2),          -- NULL = no public price
  price_text       text,                    -- as displayed, e.g. 'Contact For Price'
  msrp             numeric(12, 2),
  availability     availability NOT NULL,
  is_rental        boolean,
  data             jsonb NOT NULL,          -- latest full normalized Unit

  -- change-detection state
  details_hash     bytea NOT NULL,
  price_hash       bytea NOT NULL,
  media_hash       bytea NOT NULL,
  status           unit_status NOT NULL DEFAULT 'active',
  missed_runs      int NOT NULL DEFAULT 0,  -- consecutive healthy runs this unit was absent

  first_seen_run_id text NOT NULL REFERENCES crawl_runs(id),
  last_seen_run_id  text NOT NULL REFERENCES crawl_runs(id),
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  removed_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX units_source_status_idx ON units (source_id, status);
-- Cross-dealer duplicate detection; only real 17-char VINs (placeholders like 'TW0001' excluded).
CREATE INDEX units_vin_idx ON units (vin) WHERE vin ~ '^[A-HJ-NPR-Z0-9]{17}$';
CREATE INDEX units_make_model_year_idx ON units (make, model, year) WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- History (append-only)
-- -----------------------------------------------------------------------------

-- Full record, written only when details_hash changes (not every night).
CREATE TABLE unit_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id       bigint NOT NULL REFERENCES units(id),
  run_id        text NOT NULL REFERENCES crawl_runs(id),
  details_hash  bytea NOT NULL,
  data          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unit_snapshots_unit_idx ON unit_snapshots (unit_id, created_at DESC);

-- The change log: one row per detected change. This is what downstream consumers read
-- (and what an outbox → EventBridge/SNS publisher would tail).
CREATE TABLE unit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id      bigint NOT NULL REFERENCES units(id),
  run_id       text NOT NULL REFERENCES crawl_runs(id),
  type         unit_event_type NOT NULL,
  occurred_at  timestamptz NOT NULL,       -- run start: when we observed it, not when it happened
  changes      jsonb NOT NULL DEFAULT '{}' -- {"field": {"old": …, "new": …}} or {"added": […], "removed": […]}
);
CREATE INDEX unit_events_unit_idx ON unit_events (unit_id, occurred_at DESC);
CREATE INDEX unit_events_run_idx ON unit_events (run_id);
CREATE INDEX unit_events_type_time_idx ON unit_events (type, occurred_at DESC);

-- Price as a time series of ranges (SCD type 2). Exactly one open range per active
-- unit; the exclusion constraint makes overlapping ranges impossible at the DB level.
-- "What was the price on March 3rd?" = WHERE valid @> '2026-03-03'::timestamptz
CREATE TABLE unit_price_history (
  unit_id      bigint NOT NULL REFERENCES units(id),
  amount       numeric(12, 2),
  msrp         numeric(12, 2),
  price_text   text,
  valid        tstzrange NOT NULL,         -- [observed_from, observed_until)
  from_run_id  text NOT NULL REFERENCES crawl_runs(id),
  to_run_id    text REFERENCES crawl_runs(id),
  EXCLUDE USING gist (unit_id WITH =, valid WITH &&) DEFERRABLE INITIALLY DEFERRED  -- checked at commit, so close+open can share a statement
);
CREATE INDEX unit_price_history_open_idx ON unit_price_history (unit_id) WHERE upper_inf(valid);

CREATE TABLE unit_availability_history (
  unit_id       bigint NOT NULL REFERENCES units(id),
  availability  availability NOT NULL,
  raw           text,                      -- site's own wording, e.g. 'Sale Pending'
  valid         tstzrange NOT NULL,
  from_run_id   text NOT NULL REFERENCES crawl_runs(id),
  to_run_id     text REFERENCES crawl_runs(id),
  EXCLUDE USING gist (unit_id WITH =, valid WITH &&) DEFERRABLE INITIALLY DEFERRED  -- checked at commit, so close+open can share a statement
);
CREATE INDEX unit_availability_history_open_idx ON unit_availability_history (unit_id) WHERE upper_inf(valid);

-- -----------------------------------------------------------------------------
-- Media. Two levels so binaries are stored once no matter how many units, dealers
-- or re-signed URLs point at them.
-- -----------------------------------------------------------------------------

-- A stored binary, content-addressed. Filled by an async media worker, not the crawl.
CREATE TABLE media_assets (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256        bytea NOT NULL UNIQUE,
  content_type  text,
  bytes         bigint,
  width         int,
  height        int,
  storage_key   text NOT NULL,             -- s3://bucket/media/ab/cdef….webp
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A unit's media as listed on the site. media_key ignores query strings
-- (signatures/resizing), so a re-signed URL is not a "new photo".
CREATE TABLE unit_media (
  unit_id            bigint NOT NULL REFERENCES units(id),
  media_key          text NOT NULL,
  kind               media_kind NOT NULL,
  url                text NOT NULL,        -- latest URL seen (signatures rotate)
  position           int NOT NULL,
  asset_id           bigint REFERENCES media_assets(id),  -- NULL until downloaded
  first_seen_run_id  text NOT NULL REFERENCES crawl_runs(id),
  last_seen_run_id   text NOT NULL REFERENCES crawl_runs(id),
  removed_at         timestamptz,
  PRIMARY KEY (unit_id, media_key)
);
CREATE INDEX unit_media_pending_download_idx ON unit_media (unit_id) WHERE asset_id IS NULL AND removed_at IS NULL;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Field-level diff of two flat-ish jsonb objects: {"key": {"old": x, "new": y}} for every
-- top-level key whose value differs. Used for DETAILS_CHANGED payloads.
CREATE FUNCTION jsonb_diff(old_doc jsonb, new_doc jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, jsonb_build_object('old', old_doc -> k, 'new', new_doc -> k)), '{}'::jsonb)
  FROM (
    SELECT k FROM jsonb_object_keys(coalesce(old_doc, '{}')) k
    UNION
    SELECT k FROM jsonb_object_keys(coalesce(new_doc, '{}')) k
  ) keys(k)
  WHERE (old_doc -> k) IS DISTINCT FROM (new_doc -> k)
$$;
