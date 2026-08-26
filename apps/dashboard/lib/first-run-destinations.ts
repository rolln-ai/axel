import { entityNameError } from "./entity-name";

/**
 * The curated destination catalogue for first-run setup.
 *
 * The full destination form asks for everything a type supports (8+ fields for
 * HTTP alone) — too much for someone who signed up four minutes ago. This is
 * the deliberately shortened version: for each type, only the fields without
 * which delivery genuinely cannot happen. Everything else takes its schema
 * default and is editable later on the destination's own page.
 *
 * Field keys and the `target` value map onto the same form names the full
 * wizard uses (`dest_field_<key>`, `new_destination_target`), so the server
 * can reuse `preflightPipelineDestination` and `pipelineBindingForNewDestination`
 * unchanged.
 *
 * Every `required: true` field in the corresponding DESTINATION_SCHEMAS entry
 * must appear here, or createDestinationWithCredential will reject the insert.
 * There's a test that enforces exactly that.
 */

export type FirstRunDestinationType =
  | "postgres"
  | "bigquery"
  | "mongodb"
  | "s3"
  | "webhook";

export interface FirstRunField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  inputType?: "text" | "password" | "textarea" | "url";
}

export interface FirstRunTarget {
  label: string;
  hint: string;
  placeholder: string;
  /**
   * Split a structured target into clearly-labelled inputs while still
   * submitting the combined `new_destination_target` value expected by the
   * shared pipeline binding code. BigQuery uses this for dataset + table.
   */
  parts?: ReadonlyArray<{
    key: string;
    label: string;
    hint?: string;
    placeholder: string;
  }>;
  separator?: string;
}

export interface FirstRunTlsToggle {
  /** Form field the delivery path reads (`dest_field_<key>`). */
  key: "pg_ssl_no_verify" | "mongo_tls_no_verify";
  label: string;
  hint: string;
}

export interface FirstRunDestination {
  type: FirstRunDestinationType;
  label: string;
  /** One line, plain language: what lands where. */
  blurb: string;
  glyph: string;
  fields: FirstRunField[];
  /** Where each event is written, when the type needs one. */
  target?: FirstRunTarget;
  /**
   * Managed Postgres/Mongo hosts routinely serve self-signed certificates.
   * Axel verifies TLS by default, so without this the connection fails with
   * "self-signed certificate in certificate chain" — which is what happened to
   * a real Railway database during onboarding. It stays encrypted either way;
   * only the certificate check is relaxed.
   */
  tlsToggle?: FirstRunTlsToggle;
}

export const FIRST_RUN_DESTINATIONS: FirstRunDestination[] = [
  {
    type: "postgres",
    label: "Postgres",
    blurb: "Insert each event as a row in your database.",
    glyph: "P",
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        hint: "postgres://user:pass@host:5432/dbname — stored encrypted, never shown again. Your database must accept connections from Axel's egress IPs.",
        placeholder: "postgresql://user:pass@host:5432/dbname",
        inputType: "password",
      },
    ],
    target: {
      label: "Table",
      hint: "The table each event is written to, one JSONB row per event. Axel creates it if it doesn't exist.",
      placeholder: "events",
    },
    tlsToggle: {
      key: "pg_ssl_no_verify",
      label: "My database uses a self-signed certificate",
      hint: "Tick this for Railway, Heroku, and most managed Postgres. The connection stays encrypted — Axel just won't reject the provider's own certificate.",
    },
  },
  {
    type: "bigquery",
    label: "BigQuery",
    blurb: "Stream each event into a BigQuery table.",
    glyph: "BQ",
    fields: [
      {
        key: "project_id",
        label: "Project ID",
        hint: "The GCP project at the top of the BigQuery hierarchy. It owns the target dataset and may differ from the service account's project.",
        placeholder: "my-analytics-prod",
      },
      {
        key: "service_account_json",
        label: "Service account key (JSON)",
        hint: "Paste the whole key file. Needs BigQuery Data Editor on the dataset. Stored encrypted, never shown again.",
        placeholder: '{"type":"service_account","project_id":"…"}',
        inputType: "textarea",
      },
    ],
    target: {
      label: "BigQuery destination",
      hint: "BigQuery has no separate database field: its hierarchy is Project → Dataset → Table.",
      placeholder: "analytics.events",
      separator: ".",
      parts: [
        {
          key: "dataset",
          label: "Dataset ID",
          hint: "The database-like container inside the project. The dataset must already exist.",
          placeholder: "analytics",
        },
        {
          key: "table",
          label: "Table ID",
          hint: "The table inside the dataset. Axel creates it on first delivery if it doesn't exist.",
          placeholder: "events",
        },
      ],
    },
  },
  {
    type: "mongodb",
    label: "MongoDB",
    blurb: "Insert each event as a document in a collection.",
    glyph: "M",
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        hint: "mongodb+srv://user:pass@cluster.mongodb.net/ — stored encrypted, never shown again. Allow Axel's egress IPs under Atlas → Network Access.",
        placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/",
        inputType: "password",
      },
      {
        key: "database",
        label: "Database",
        placeholder: "axel_events",
      },
    ],
    target: {
      label: "Collection",
      hint: "The collection each event document is inserted into.",
      placeholder: "events",
    },
    tlsToggle: {
      key: "mongo_tls_no_verify",
      label: "My database uses a self-signed certificate",
      hint: "The connection stays encrypted — Axel just won't reject the provider's own certificate.",
    },
  },
  {
    type: "s3",
    label: "S3",
    blurb: "Write each event to an object-storage bucket.",
    glyph: "S3",
    fields: [
      { key: "bucket", label: "Bucket name", placeholder: "my-event-bucket" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access key ID", placeholder: "AKIA…" },
      {
        key: "secret_access_key",
        label: "Secret access key",
        hint: "Stored encrypted, never shown again.",
        inputType: "password",
      },
    ],
  },
  {
    type: "webhook",
    label: "HTTP endpoint",
    blurb: "POST each event to a URL, signed so you can verify it.",
    glyph: "⌬",
    fields: [
      {
        key: "url",
        label: "Endpoint URL",
        hint: "Axel POSTs each event here and signs it. We'll generate the signing secret.",
        placeholder: "https://api.example.com/webhooks/axel",
        inputType: "url",
      },
    ],
  },
];

export function firstRunDestination(
  type: string,
): FirstRunDestination | undefined {
  return FIRST_RUN_DESTINATIONS.find((d) => d.type === type);
}

/**
 * Validate the write target BEFORE the destination is saved.
 *
 * The delivery path quotes these identifiers and refuses anything outside a
 * narrow charset. Accepting a name it will later reject doesn't fail loudly —
 * it dead-letters every single event, forever, while the UI shows a pipeline
 * that looks connected. A user typing a perfectly reasonable `test-5` hit
 * exactly that. Mirrors `quotePgIdent` in @axel/shared (pg-columns.ts) and
 * `isSafeTableIdent` in delivery-edge — keep them in sync.
 *
 * Returns null when valid, else a message naming the fix.
 */
export function validateDestinationTarget(
  type: FirstRunDestinationType,
  rawTarget: string,
): string | null {
  const target = rawTarget.trim();
  const spec = firstRunDestination(type);
  if (!spec?.target) return null;
  if (!target) return `${spec.target.label} is required.`;

  switch (type) {
    case "postgres": {
      // Optionally schema-qualified; each part quoted separately downstream.
      // Hyphens are the common trap — valid in a quoted identifier in theory,
      // rejected by the delivery path in practice.
      const parts = target.split(".");
      if (parts.length > 2) {
        return "Use either a table name or schema.table — not more than one dot.";
      }
      for (const part of parts) {
        if (!/^[A-Za-z0-9_]+$/.test(part)) {
          return `Table names can use letters, numbers, and underscores only — no hyphens or spaces. Try ${target.replace(/[^A-Za-z0-9_.]/g, "_")}.`;
        }
      }
      return null;
    }
    case "mongodb": {
      // Mongo forbids $ and null bytes, reserves the system. prefix, and caps
      // the name length.
      if (/[$\0]/.test(target)) return "Collection names can't contain $ or null characters.";
      if (target.startsWith("system.")) return "Collection names can't start with “system.” — that prefix is reserved.";
      if (target.length > 120) return "Collection name is too long.";
      return null;
    }
    case "bigquery": {
      // dataset.table — dataset is letters/numbers/underscores; the table may
      // also contain hyphens. Mirrors normalizeBigQueryTarget.
      const parts = target.split(".");
      if (parts.length !== 2) {
        return "Use dataset.table format, for example analytics.events.";
      }
      const [dataset, table] = parts as [string, string];
      if (!dataset) return "Dataset ID is required.";
      if (!table) return "Table ID is required.";
      if (!/^[A-Za-z0-9_]{1,1024}$/.test(dataset)) {
        return "Dataset IDs can use letters, numbers, and underscores only.";
      }
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(table)) {
        return "Table IDs can use letters, numbers, underscores, and hyphens only.";
      }
      return null;
    }
    default:
      return null;
  }
}

/** Accepts only http(s) URLs; returns a message the user can act on. */
export function parseDestinationUrl(
  raw: string,
): { url: URL } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter the URL Axel should POST your events to." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      error:
        "That doesn't look like a URL — include the scheme, e.g. https://api.example.com/hooks.",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "Use an http:// or https:// URL." };
  }
  return { url };
}

/**
 * A human label for the destination, derived from what the user typed, so
 * they never have to invent one: the endpoint's host, the bucket, the
 * database, the GCP project.
 */
export function deriveDestinationNameBase(
  type: FirstRunDestinationType,
  values: Record<string, string>,
): string {
  const pick = (key: string) => (values[key] ?? "").trim();
  let candidate = "";
  switch (type) {
    case "webhook": {
      const parsed = parseDestinationUrl(pick("url"));
      candidate = "url" in parsed ? parsed.url.hostname.replace(/\.$/, "") : "";
      break;
    }
    case "s3":
      candidate = pick("bucket");
      break;
    case "mongodb":
      candidate = pick("database");
      break;
    case "bigquery":
      candidate = pick("project_id");
      break;
    case "postgres": {
      // Hostname out of the DSN, so two Postgres destinations are told apart.
      // Never surfaces credentials: only the host portion is used.
      try {
        candidate = new URL(pick("connection_string")).hostname.replace(/\.$/, "");
      } catch {
        candidate = "";
      }
      break;
    }
  }
  // Fall back to the type's own label when the derived value isn't a usable
  // display name (an IPv6 literal, an empty field, a bare IP with a trailing dot).
  if (!candidate || entityNameError(candidate) !== null) {
    return firstRunDestination(type)?.label ?? "Destination";
  }
  return candidate;
}

/**
 * Disambiguates against names already in the workspace. The user never typed
 * this name, so a unique violation would be unactionable for them.
 * `takenNames` must be lowercased.
 */
export function uniqueDestinationName(base: string, takenNames: Set<string>): string {
  if (!takenNames.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`.slice(0, 64).trim();
    if (!takenNames.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
