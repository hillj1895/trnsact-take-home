-- =============================================================================
-- 0002_details_doc — the "details" facet of a unit as a flat jsonb document, so
-- jsonb_diff() can report field-level changes like {"spec:Engine Make": {old, new}}
-- instead of "specs changed". Mirrors detailsFacet() in packages/core/src/hash.ts.
-- =============================================================================

CREATE FUNCTION details_doc(data jsonb, ignore_specs text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT (data - ARRAY['scrapedAt', 'warnings', 'media', 'price', 'availability', 'availabilityRaw',
                       'specs', 'sourceId', 'dealerId', 'sourceUnitKey'])
         || coalesce((
              SELECT jsonb_object_agg('spec:' || key, value)
              FROM jsonb_each(coalesce(data -> 'specs', '{}'))
              WHERE lower(key) <> ALL (SELECT lower(s) FROM unnest(ignore_specs) s)
            ), '{}'::jsonb)
$$;
