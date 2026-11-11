import type pg from 'pg';

/**
 * Apply one staged run to current state + history, in ONE transaction, using
 * set-based SQL. See docs/change-detection-plan.md.
 *
 *   guard → classify (temp table m) → NEW → RELISTED → PRICE / AVAILABILITY /
 *   DETAILS / MEDIA changes → touch seen units → MISSING/REMOVED (healthy runs only)
 *   → stats + mark applied
 *
 * Every step is a single statement over the whole run, so cost scales with the
 * number of units that changed, not with round-trips per unit.
 */

export interface ApplyStats {
  runId: string;
  skipped?: string;
  staged: number;
  events: Record<string, number>;
  missedUnderGrace: number;
  removalCheck: 'applied' | 'skipped (unhealthy or partial run)';
}

/** units column ← expression over a row of `m` (the run's staged data). */
const UNIT_COLUMNS: Array<[column: string, expr: string]> = [
  ['vin', `m.data->>'vin'`],
  ['stock_number', `m.data->>'stockNumber'`],
  ['platform_id', `m.data->>'platformId'`],
  ['listing_url', `m.data->>'listingUrl'`],
  ['year', `(m.data->>'year')::smallint`],
  ['make', `m.data->>'make'`],
  ['model', `m.data->>'model'`],
  ['category', `m.data->>'category'`],
  ['condition', `(m.data->>'condition')::unit_condition`],
  ['mileage', `(m.data->>'mileage')::numeric`],
  ['hours', `(m.data->>'hours')::numeric`],
  ['location', `m.data->>'location'`],
  ['price_amount', `(m.data->'price'->>'amount')::numeric`],
  ['price_text', `m.data->'price'->>'text'`],
  ['msrp', `(m.data->'price'->>'msrp')::numeric`],
  ['availability', `m.availability`],
  ['is_rental', `(m.data->>'isRental')::boolean`],
  ['data', `m.data`],
  ['details_hash', `m.details_hash`],
  ['price_hash', `m.price_hash`],
  ['media_hash', `m.media_hash`],
];
const COLS = UNIT_COLUMNS.map(([c]) => c).join(', ');
const EXPRS = UNIT_COLUMNS.map(([, e]) => e).join(', ');
const SETS = UNIT_COLUMNS.map(([c, e]) => `${c} = ${e}`).join(', ');

const NEW_AMOUNT = `(m.data->'price'->>'amount')::numeric`;
const NEW_MSRP = `(m.data->'price'->>'msrp')::numeric`;
const NEW_TEXT = `m.data->'price'->>'text'`;
const oldNew = (o: string, n: string) => `jsonb_build_object('old', to_jsonb(${o}), 'new', to_jsonb(${n}))`;

/** Media keys in `a` that are not in `b` (both jsonb arrays of MediaItem). */
const mediaKeysMinus = (a: string, b: string) => `(
  SELECT coalesce(jsonb_agg(x->>'key'), '[]'::jsonb) FROM jsonb_array_elements(coalesce(${a}, '[]')) x
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${b}, '[]')) y WHERE y->>'key' = x->>'key'))`;

export async function applyRun(pool: pg.Pool, runId: string): Promise<ApplyStats> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- 1. Guard -------------------------------------------------------------
    const run = (
      await client.query(
        `SELECT r.id, r.source_id, r.status, r.healthy, r.partial, r.started_at, r.applied_at,
                s.removal_grace_runs,
                ARRAY(SELECT jsonb_array_elements_text(coalesce(s.config->'detail'->'hashIgnoreSpecs', '[]'))) AS ignore_specs
         FROM crawl_runs r JOIN sources s ON s.id = r.source_id
         WHERE r.id = $1 FOR UPDATE OF r`,
        [runId],
      )
    ).rows[0];
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.applied_at) {
      await client.query('ROLLBACK');
      return { runId, skipped: 'already applied', staged: 0, events: {}, missedUnderGrace: 0, removalCheck: 'skipped (unhealthy or partial run)' };
    }
    if (run.status !== 'succeeded') throw new Error(`run ${runId} has status ${run.status}; only succeeded runs are applied`);
    const later = await client.query(
      `SELECT id FROM crawl_runs WHERE source_id = $1 AND applied_at IS NOT NULL AND started_at >= $2 LIMIT 1`,
      [run.source_id, run.started_at],
    );
    if (later.rowCount) throw new Error(`run ${runId} is older than already-applied run ${later.rows[0].id}; runs must apply in order`);

    const src = run.source_id as string;
    const at = run.started_at as Date; // observation time for every event/range in this run
    const ignore = run.ignore_specs as string[];

    // ---- 2. Classify: staged rows joined to current state ----------------------
    await client.query(`
      CREATE TEMP TABLE m (
        source_unit_key text PRIMARY KEY, data jsonb, details_hash bytea, price_hash bytea, media_hash bytea,
        availability availability, availability_raw text,
        unit_id bigint, old_status unit_status, old_data jsonb,
        old_details_hash bytea, old_price_hash bytea, old_media_hash bytea,
        old_availability availability, old_availability_raw text,
        old_amount numeric, old_msrp numeric, old_text text,
        is_new boolean NOT NULL DEFAULT false, is_relisted boolean NOT NULL DEFAULT false
      ) ON COMMIT DROP`);
    const staged = await client.query(
      `INSERT INTO m
       SELECT s.source_unit_key, s.data, s.details_hash, s.price_hash, s.media_hash,
              s.availability, s.data->>'availabilityRaw',
              u.id, u.status, u.data, u.details_hash, u.price_hash, u.media_hash,
              u.availability, u.data->>'availabilityRaw', u.price_amount, u.msrp, u.price_text
       FROM staged_units s
       LEFT JOIN units u ON u.source_id = $2 AND u.source_unit_key = s.source_unit_key
       WHERE s.run_id = $1`,
      [runId, src],
    );

    // ---- 3. NEW ----------------------------------------------------------------
    await client.query(
      `WITH ins AS (
         INSERT INTO units (source_id, source_unit_key, ${COLS}, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at)
         SELECT $2, m.source_unit_key, ${EXPRS}, $1, $1, $3, $3 FROM m WHERE m.unit_id IS NULL
         RETURNING id, source_unit_key)
       UPDATE m SET unit_id = ins.id, is_new = true FROM ins WHERE m.source_unit_key = ins.source_unit_key`,
      [runId, src, at],
    );
    await client.query(
      `INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'NEW', $2, jsonb_build_object('price', data->'price', 'availability', availability)
       FROM m WHERE is_new`,
      [runId, at],
    );

    // ---- 4. RELISTED (seen again after REMOVED) --------------------------------
    await client.query(`UPDATE m SET is_relisted = true WHERE NOT is_new AND old_status = 'removed'`);
    await client.query(
      `INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'RELISTED', $2, jsonb_build_object(
         'price', ${oldNew('m.old_amount', NEW_AMOUNT)},
         'availability', ${oldNew('m.old_availability', 'm.availability')})
       FROM m WHERE is_relisted`,
      [runId, at],
    );

    // Snapshots for new units, relisted units, and anyone whose details changed.
    await client.query(
      `INSERT INTO unit_snapshots (unit_id, run_id, details_hash, data)
       SELECT unit_id, $1, details_hash, data FROM m
       WHERE is_new OR is_relisted OR details_hash <> old_details_hash`,
      [runId],
    );
    // Removal closed their ranges; new + relisted units get fresh open ranges.
    await client.query(
      `INSERT INTO unit_price_history (unit_id, amount, msrp, price_text, valid, from_run_id)
       SELECT unit_id, ${NEW_AMOUNT}, ${NEW_MSRP}, ${NEW_TEXT}, tstzrange($2, NULL), $1 FROM m WHERE is_new OR is_relisted`,
      [runId, at],
    );
    await client.query(
      `INSERT INTO unit_availability_history (unit_id, availability, raw, valid, from_run_id)
       SELECT unit_id, availability, availability_raw, tstzrange($2, NULL), $1 FROM m WHERE is_new OR is_relisted`,
      [runId, at],
    );

    // ---- 5. CHANGED facets (active units only) ---------------------------------
    // Price: close the open range, open a new one, log the event — one statement.
    // (History exclusion constraints are DEFERRED, so close+open can share it.)
    await client.query(
      `WITH c AS (SELECT * FROM m WHERE NOT is_new AND NOT is_relisted AND price_hash <> old_price_hash),
       closed AS (
         UPDATE unit_price_history h SET valid = tstzrange(lower(h.valid), $2), to_run_id = $1
         FROM c WHERE h.unit_id = c.unit_id AND upper_inf(h.valid)),
       opened AS (
         INSERT INTO unit_price_history (unit_id, amount, msrp, price_text, valid, from_run_id)
         SELECT unit_id, ${NEW_AMOUNT.replaceAll('m.', 'c.')}, ${NEW_MSRP.replaceAll('m.', 'c.')}, ${NEW_TEXT.replaceAll('m.', 'c.')},
                tstzrange($2, NULL), $1 FROM c)
       INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'PRICE_CHANGED', $2,
         jsonb_build_object(
           'amount', ${oldNew('c.old_amount', NEW_AMOUNT.replaceAll('m.', 'c.'))},
           'text',   ${oldNew('c.old_text', NEW_TEXT.replaceAll('m.', 'c.'))})
         || CASE WHEN c.old_msrp IS DISTINCT FROM ${NEW_MSRP.replaceAll('m.', 'c.')}
                 THEN jsonb_build_object('msrp', ${oldNew('c.old_msrp', NEW_MSRP.replaceAll('m.', 'c.'))})
                 ELSE '{}'::jsonb END
       FROM c`,
      [runId, at],
    );

    await client.query(
      `WITH c AS (
         SELECT * FROM m WHERE NOT is_new AND NOT is_relisted
           AND (availability <> old_availability OR availability_raw IS DISTINCT FROM old_availability_raw)),
       closed AS (
         UPDATE unit_availability_history h SET valid = tstzrange(lower(h.valid), $2), to_run_id = $1
         FROM c WHERE h.unit_id = c.unit_id AND upper_inf(h.valid)),
       opened AS (
         INSERT INTO unit_availability_history (unit_id, availability, raw, valid, from_run_id)
         SELECT unit_id, availability, availability_raw, tstzrange($2, NULL), $1 FROM c)
       INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'AVAILABILITY_CHANGED', $2, jsonb_build_object(
         'availability', ${oldNew('c.old_availability', 'c.availability')},
         'raw', ${oldNew('c.old_availability_raw', 'c.availability_raw')})
       FROM c`,
      [runId, at],
    );

    await client.query(
      `INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'DETAILS_CHANGED', $2, jsonb_diff(details_doc(old_data, $3), details_doc(data, $3))
       FROM m WHERE NOT is_new AND details_hash <> old_details_hash`,
      [runId, at, ignore],
    );

    await client.query(
      `INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
       SELECT unit_id, $1, 'MEDIA_CHANGED', $2, jsonb_build_object(
         'added',   ${mediaKeysMinus(`m.data->'media'`, `m.old_data->'media'`)},
         'removed', ${mediaKeysMinus(`m.old_data->'media'`, `m.data->'media'`)},
         'count',   ${oldNew(`jsonb_array_length(m.old_data->'media')`, `jsonb_array_length(m.data->'media')`)})
       FROM m WHERE NOT is_new AND media_hash <> old_media_hash`,
      [runId, at],
    );

    // unit_media listing rows: only for units whose media set changed (or are new).
    await client.query(
      `UPDATE unit_media um SET removed_at = $1
       FROM m WHERE um.unit_id = m.unit_id AND (m.is_new OR m.media_hash IS DISTINCT FROM m.old_media_hash)
         AND um.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.data->'media') x WHERE x->>'key' = um.media_key)`,
      [at],
    );
    await client.query(
      `INSERT INTO unit_media (unit_id, media_key, kind, url, position, first_seen_run_id, last_seen_run_id)
       SELECT m.unit_id, x.key, x.kind, x.url, x.position, $1, $1
       FROM m, jsonb_to_recordset(m.data->'media') AS x(key text, kind media_kind, url text, position int)
       WHERE m.is_new OR m.media_hash IS DISTINCT FROM m.old_media_hash
       ON CONFLICT (unit_id, media_key) DO UPDATE SET
         url = excluded.url, position = excluded.position, last_seen_run_id = excluded.last_seen_run_id, removed_at = NULL`,
      [runId],
    );

    // ---- 6. Touch every seen unit: current state + presence ---------------------
    await client.query(
      `UPDATE units u SET ${SETS},
         status = 'active', missed_runs = 0, removed_at = NULL,
         last_seen_run_id = $1, last_seen_at = $2, updated_at = now()
       FROM m WHERE u.id = m.unit_id AND NOT m.is_new`,
      [runId, at],
    );

    // ---- 7. MISSING → REMOVED: only when we trust this run's view of inventory ---
    let missedUnderGrace = 0;
    const trust = run.healthy === true && run.partial === false;
    if (trust) {
      await client.query(
        `UPDATE units u SET missed_runs = missed_runs + 1, updated_at = now()
         WHERE u.source_id = $1 AND u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM m WHERE m.unit_id = u.id)`,
        [src],
      );
      await client.query(
        `WITH r AS (
           UPDATE units u SET status = 'removed', removed_at = $2, updated_at = now()
           WHERE u.source_id = $3 AND u.status = 'active' AND u.missed_runs >= $4
           RETURNING u.id, u.availability, u.missed_runs, u.last_seen_at, u.last_seen_run_id),
         cp AS (
           UPDATE unit_price_history h SET valid = tstzrange(lower(h.valid), $2), to_run_id = $1
           FROM r WHERE h.unit_id = r.id AND upper_inf(h.valid)),
         ca AS (
           UPDATE unit_availability_history h SET valid = tstzrange(lower(h.valid), $2), to_run_id = $1
           FROM r WHERE h.unit_id = r.id AND upper_inf(h.valid))
         INSERT INTO unit_events (unit_id, run_id, type, occurred_at, changes)
         SELECT id, $1, 'REMOVED', $2, jsonb_build_object(
           'lastAvailability', availability, 'missedRuns', missed_runs,
           'lastSeenAt', last_seen_at, 'lastSeenRunId', last_seen_run_id)
         FROM r`,
        [runId, at, src, run.removal_grace_runs],
      );
      missedUnderGrace = Number(
        (
          await client.query(`SELECT count(*) FROM units WHERE source_id = $1 AND status = 'active' AND missed_runs > 0`, [src])
        ).rows[0].count,
      );
    }

    // ---- 8. Stats, mark applied, clear staging ----------------------------------
    const events: Record<string, number> = {};
    for (const row of (
      await client.query(`SELECT type, count(*)::int AS n FROM unit_events WHERE run_id = $1 GROUP BY type ORDER BY type`, [runId])
    ).rows) {
      events[row.type] = row.n;
    }
    const stats: ApplyStats = {
      runId,
      staged: staged.rowCount ?? 0,
      events,
      missedUnderGrace,
      removalCheck: trust ? 'applied' : 'skipped (unhealthy or partial run)',
    };
    await client.query(`UPDATE crawl_runs SET applied_at = now(), apply_stats = $2 WHERE id = $1`, [runId, stats]);
    await client.query(`DELETE FROM staged_units WHERE run_id = $1`, [runId]);
    await client.query('COMMIT');
    return stats;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
