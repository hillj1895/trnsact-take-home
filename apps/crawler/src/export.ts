import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from '@trnsact/db';

/**
 * Database → flat files: CSV for spreadsheets, NDJSON where nested data
 * (full unit records, event payloads) matters. Works on any inventory DB, not
 * only simulations.
 */
export interface ExportOptions {
  /** Only export one source. */
  sourceId?: string;
  /** Text substitution applied to every output, e.g. a mock host → the real origin. */
  rewrite?: { from: string; to: string };
}

const QUERIES: Record<string, { sql: string; formats: Array<'csv' | 'ndjson'> }> = {
  runs: {
    formats: ['csv'],
    sql: `SELECT r.id AS run_id, r.source_id, r.config_version, r.started_at, r.finished_at, r.healthy, r.partial,
            r.summary->'counts'->>'siteTotal' AS site_total, r.summary->'counts'->>'discovered' AS discovered,
            r.summary->'counts'->>'detailFailed' AS detail_failed, r.summary->'http'->>'requests' AS http_requests,
            r.summary->'health'->'reasons' AS health_reasons, r.apply_stats->'events' AS events,
            r.apply_stats->>'removalCheck' AS removal_check
          FROM crawl_runs r WHERE ($1::text IS NULL OR r.source_id = $1) ORDER BY r.started_at`,
  },
  units: {
    formats: ['csv'],
    sql: `SELECT u.source_id, u.source_unit_key, u.stock_number, u.vin, u.year, u.make, u.model, u.category, u.condition,
            u.mileage, u.hours, u.location, u.price_amount, u.msrp, u.price_text, u.availability, u.data->>'availabilityRaw' AS availability_raw,
            u.is_rental, u.status, u.missed_runs, jsonb_array_length(u.data->'media') AS media_count,
            u.first_seen_at, u.last_seen_at, u.removed_at, u.listing_url
          FROM units u WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY u.source_id, u.stock_number`,
  },
  units_full: {
    formats: ['ndjson'],
    sql: `SELECT u.source_id, u.source_unit_key, u.status, u.first_seen_at, u.last_seen_at, u.removed_at, u.data AS unit
          FROM units u WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY u.source_id, u.stock_number`,
  },
  events: {
    formats: ['csv', 'ndjson'],
    sql: `SELECT e.id AS event_id, e.occurred_at, e.run_id, u.source_id, u.source_unit_key, u.stock_number, u.vin,
            u.year, u.make, u.model, e.type, e.changes
          FROM unit_events e JOIN units u ON u.id = e.unit_id
          WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY e.occurred_at, e.type, u.stock_number`,
  },
  price_history: {
    formats: ['csv'],
    sql: `SELECT u.source_id, u.source_unit_key, u.stock_number, h.amount, h.msrp, h.price_text,
            lower(h.valid) AS valid_from, upper(h.valid) AS valid_to, h.from_run_id, h.to_run_id
          FROM unit_price_history h JOIN units u ON u.id = h.unit_id
          WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY u.stock_number, lower(h.valid)`,
  },
  availability_history: {
    formats: ['csv'],
    sql: `SELECT u.source_id, u.source_unit_key, u.stock_number, h.availability, h.raw,
            lower(h.valid) AS valid_from, upper(h.valid) AS valid_to, h.from_run_id, h.to_run_id
          FROM unit_availability_history h JOIN units u ON u.id = h.unit_id
          WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY u.stock_number, lower(h.valid)`,
  },
  media: {
    formats: ['csv'],
    sql: `SELECT u.source_id, u.source_unit_key, u.stock_number, m.kind, m.position, m.media_key, m.url,
            m.first_seen_run_id, m.last_seen_run_id, m.removed_at
          FROM unit_media m JOIN units u ON u.id = m.unit_id
          WHERE ($1::text IS NULL OR u.source_id = $1) ORDER BY u.stock_number, m.removed_at NULLS FIRST, m.position`,
  },
};

export async function exportDatabase(db: Pool, outDir: string, opts: ExportOptions = {}): Promise<Record<string, number>> {
  await mkdir(outDir, { recursive: true });
  const rewrite = (s: string) => (opts.rewrite ? s.replaceAll(opts.rewrite.from, opts.rewrite.to) : s);
  const counts: Record<string, number> = {};
  for (const [name, q] of Object.entries(QUERIES)) {
    const { rows, fields } = await db.query(q.sql, [opts.sourceId ?? null]);
    for (const format of q.formats) {
      const file = `${name}.${format}`;
      const body =
        format === 'csv'
          ? [fields.map((f) => f.name).join(','), ...rows.map((r) => fields.map((f) => csvCell(r[f.name])).join(','))].join('\n') + '\n'
          : rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await writeFile(path.join(outDir, file), rewrite(body));
      counts[file] = rows.length;
    }
  }
  return counts;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
