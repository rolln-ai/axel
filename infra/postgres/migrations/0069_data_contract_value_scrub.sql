-- Migration 0069: Data Contracts retain schema metadata, not webhook values.
--
-- Inferred examples, enum/status values, mapping previews, fixture bodies, and
-- drift sample references were copied into durable Postgres rows. That made
-- those copies outlive raw-payload retention, transient mode, subject erasure,
-- and workspace event-data wipes. The functions and triggers below scrub old
-- rows and enforce the same rule for every future writer.

CREATE OR REPLACE FUNCTION axel_scrub_data_contract_schema_node(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  kind text;
  cleaned jsonb;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  kind := jsonb_typeof(value);
  IF kind = 'array' THEN
    SELECT COALESCE(jsonb_agg(axel_scrub_data_contract_schema_node(item)), '[]'::jsonb)
      INTO cleaned
      FROM jsonb_array_elements(value) AS items(item);
    RETURN cleaned;
  END IF;
  IF kind = 'object' THEN
    SELECT COALESCE(
             jsonb_object_agg(
               key,
               CASE
                 WHEN key IN ('values', 'example_event_ids') THEN '[]'::jsonb
                 ELSE axel_scrub_data_contract_schema_node(child)
               END
             ),
             '{}'::jsonb
           )
      INTO cleaned
      FROM jsonb_each(value) AS entries(key, child)
     WHERE key NOT IN ('examples', 'enum_values', 'numeric_range');
    RETURN cleaned;
  END IF;
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION axel_scrub_data_contract_schema(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned jsonb;
BEGIN
  cleaned := axel_scrub_data_contract_schema_node(COALESCE(value, '{}'::jsonb));
  IF jsonb_typeof(cleaned) <> 'object' THEN
    cleaned := '{}'::jsonb;
  END IF;
  RETURN jsonb_set(
    cleaned,
    '{summary}',
    to_jsonb('Stored schema metadata. Observed payload values removed.'::text),
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION axel_strip_data_contract_previews(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  kind text;
  cleaned jsonb;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  kind := jsonb_typeof(value);
  IF kind = 'array' THEN
    SELECT COALESCE(jsonb_agg(axel_strip_data_contract_previews(item)), '[]'::jsonb)
      INTO cleaned
      FROM jsonb_array_elements(value) AS items(item);
    RETURN cleaned;
  END IF;
  IF kind = 'object' THEN
    SELECT COALESCE(
             jsonb_object_agg(key, axel_strip_data_contract_previews(child)),
             '{}'::jsonb
           )
      INTO cleaned
      FROM jsonb_each(value) AS entries(key, child)
     WHERE key <> 'preview';
    RETURN cleaned;
  END IF;
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION axel_generalize_data_contract_fixture(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  kind text;
  cleaned jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) = 'null' THEN
    RETURN 'null'::jsonb;
  END IF;
  kind := jsonb_typeof(value);
  IF kind = 'array' THEN
    IF jsonb_array_length(value) = 0 THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN jsonb_build_array(axel_generalize_data_contract_fixture(value -> 0));
  END IF;
  IF kind = 'object' THEN
    SELECT COALESCE(
             jsonb_object_agg(
               CASE
                 WHEN key ~ '^[A-Za-z_][A-Za-z0-9_.-]{0,127}$' THEN key
                 ELSE 'field_' || ordinal::text
               END,
               axel_generalize_data_contract_fixture(child)
             ),
             '{}'::jsonb
           )
      INTO cleaned
      FROM jsonb_each(value) WITH ORDINALITY AS entries(key, child, ordinal);
    RETURN cleaned;
  END IF;
  IF kind = 'string' THEN
    RETURN to_jsonb('[STRING]'::text);
  END IF;
  IF kind = 'number' THEN
    RETURN '0'::jsonb;
  END IF;
  IF kind = 'boolean' THEN
    RETURN 'false'::jsonb;
  END IF;
  RETURN 'null'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION axel_data_contract_json_allowlist(value jsonb, keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END
    ) AS entry
   WHERE entry.key = ANY(keys)
$$;

-- Repair any historical workspace copies before the ownership trigger begins
-- rejecting them. The parent Data Contract is authoritative.
UPDATE data_contract_versions v
   SET workspace_id = c.workspace_id
  FROM data_contracts c
 WHERE c.id = v.data_contract_id
   AND v.workspace_id IS DISTINCT FROM c.workspace_id;

UPDATE data_contract_fixtures f
   SET workspace_id = v.workspace_id
  FROM data_contract_versions v
 WHERE v.id = f.data_contract_version_id
   AND f.workspace_id IS DISTINCT FROM v.workspace_id;

UPDATE data_contract_drift_events d
   SET workspace_id = v.workspace_id
  FROM data_contract_versions v
 WHERE v.id = d.data_contract_version_id
   AND d.workspace_id IS DISTINCT FROM v.workspace_id;

-- A mapping that points outside its version's workspace cannot be retained.
UPDATE data_contract_versions v
   SET destination_mapping = NULL
 WHERE destination_mapping IS NOT NULL
   AND (
     jsonb_typeof(destination_mapping) <> 'object'
     OR NULLIF(destination_mapping ->> 'destination_id', '') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM destinations d
        WHERE d.id = destination_mapping ->> 'destination_id'
          AND d.workspace_id = v.workspace_id
     )
   );

UPDATE data_contract_versions
   SET inferred_schema = axel_scrub_data_contract_schema(inferred_schema),
       destination_mapping = axel_strip_data_contract_previews(destination_mapping),
       model_metadata = axel_data_contract_json_allowlist(
         model_metadata,
         ARRAY[
           'model', 'prompt_version', 'sample_count', 'llm_enriched', 'ms', 'auto',
           'auto_extended_at', 'auto_extended_from_version_id',
           'manually_extended_at', 'manually_extended_from_version_id',
           'manually_extended_by_user_id', 'destination_mapping_saved_at',
           'destination_mapping_saved_by_user_id', 'codegen_at', 'codegen_by_user_id',
           'patched_at', 'patched_by_user_id', 'patch_confidence'
         ]::text[]
       ),
       fixture_results = CASE
         WHEN fixture_results IS NULL THEN NULL
         ELSE axel_data_contract_json_allowlist(
           fixture_results,
           ARRAY['passed', 'failed', 'total', 'ran_at']::text[]
         )
       END;

-- Existing fixtures may contain sensitive object keys that a scalar redactor
-- cannot recognize. They are derived and can be regenerated, so deletion is
-- safer than trying to rewrite them in place.
DELETE FROM data_contract_fixtures;

UPDATE data_contract_drift_events
   SET sample_event_id = NULL,
       detail = '{}'::jsonb;

CREATE OR REPLACE FUNCTION axel_enforce_data_contract_version_privacy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mapped_destination_id text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM data_contracts c
     WHERE c.id = NEW.data_contract_id
       AND c.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'data contract version workspace mismatch'
      USING ERRCODE = '23503';
  END IF;

  NEW.inferred_schema := axel_scrub_data_contract_schema(NEW.inferred_schema);
  NEW.destination_mapping := axel_strip_data_contract_previews(NEW.destination_mapping);
  NEW.model_metadata := axel_data_contract_json_allowlist(
    NEW.model_metadata,
    ARRAY[
      'model', 'prompt_version', 'sample_count', 'llm_enriched', 'ms', 'auto',
      'auto_extended_at', 'auto_extended_from_version_id',
      'manually_extended_at', 'manually_extended_from_version_id',
      'manually_extended_by_user_id', 'destination_mapping_saved_at',
      'destination_mapping_saved_by_user_id', 'codegen_at', 'codegen_by_user_id',
      'patched_at', 'patched_by_user_id', 'patch_confidence'
    ]::text[]
  );
  NEW.fixture_results := CASE
    WHEN NEW.fixture_results IS NULL THEN NULL
    ELSE axel_data_contract_json_allowlist(
      NEW.fixture_results,
      ARRAY['passed', 'failed', 'total', 'ran_at']::text[]
    )
  END;

  IF NEW.destination_mapping IS NOT NULL THEN
    IF jsonb_typeof(NEW.destination_mapping) <> 'object' THEN
      RAISE EXCEPTION 'data contract destination mapping must be an object'
        USING ERRCODE = '23514';
    END IF;
    mapped_destination_id := NULLIF(NEW.destination_mapping ->> 'destination_id', '');
    IF mapped_destination_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM destinations d
       WHERE d.id = mapped_destination_id
         AND d.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'data contract destination workspace mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_contract_versions_privacy_guard
  ON data_contract_versions;
CREATE TRIGGER data_contract_versions_privacy_guard
BEFORE INSERT OR UPDATE ON data_contract_versions
FOR EACH ROW EXECUTE FUNCTION axel_enforce_data_contract_version_privacy();

CREATE OR REPLACE FUNCTION axel_enforce_data_contract_fixture_privacy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM data_contract_versions v
     WHERE v.id = NEW.data_contract_version_id
       AND v.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'data contract fixture workspace mismatch'
      USING ERRCODE = '23503';
  END IF;
  NEW.source_event_id := NULL;
  NEW.event_type := NULL;
  NEW.input_payload := axel_generalize_data_contract_fixture(NEW.input_payload);
  NEW.expected_output := axel_generalize_data_contract_fixture(NEW.expected_output);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_contract_fixtures_privacy_guard
  ON data_contract_fixtures;
CREATE TRIGGER data_contract_fixtures_privacy_guard
BEFORE INSERT OR UPDATE ON data_contract_fixtures
FOR EACH ROW EXECUTE FUNCTION axel_enforce_data_contract_fixture_privacy();

CREATE OR REPLACE FUNCTION axel_enforce_data_contract_drift_privacy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM data_contract_versions v
     WHERE v.id = NEW.data_contract_version_id
       AND v.data_contract_id = NEW.data_contract_id
       AND v.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'data contract drift workspace mismatch'
      USING ERRCODE = '23503';
  END IF;
  NEW.sample_event_id := NULL;
  NEW.detail := '{}'::jsonb;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_contract_drift_events_privacy_guard
  ON data_contract_drift_events;
CREATE TRIGGER data_contract_drift_events_privacy_guard
BEFORE INSERT OR UPDATE ON data_contract_drift_events
FOR EACH ROW EXECUTE FUNCTION axel_enforce_data_contract_drift_privacy();
