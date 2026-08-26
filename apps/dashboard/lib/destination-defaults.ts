/**
 * Per-type destination field schemas — the source of truth for the
 * destinations create/edit form. Every field is either:
 *
 *   - `kind: "config"`  — non-secret value, lives in `destinations.config` jsonb
 *                         (database name, table name, region, key prefix, etc).
 *                         Visible in the dashboard list / detail view.
 *   - `kind: "secret"`  — sensitive value, lives encrypted in
 *                         `destination_credentials`. The form takes plaintext
 *                         and the create action immediately encrypts before
 *                         hitting Postgres. Plaintext is never read back.
 *
 * Adding a new field is a one-line change here. The form, validation, and
 * audit log all read from this schema, so they stay in sync.
 *
 * NOTE: this file is client-safe (no node:crypto, no DB imports). The
 * encrypt path lives in `lib/credentials.ts` (server-only).
 */

export type DestinationType =
  | "webhook"
  | "http"
  | "mongodb"
  | "postgres"
  | "s3"
  | "r2"
  | "databricks_sql"
  | "databricks_volume"
  | "bigquery";

export interface DestinationField {
  /** The form field name (and the JSON key in `config` or the credential payload). */
  key: string;
  /** Human label shown above the input. */
  label: string;
  /** Help text shown below the input. */
  hint?: string;
  /** Where the value lives once saved. */
  kind: "config" | "secret";
  /** HTML input type — defaults to "text". "textarea" renders a multi-line box. */
  inputType?: "text" | "url" | "number" | "password" | "select" | "textarea";
  /** AXE-33 — options for `inputType: "select"`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Optional placeholder text. */
  placeholder?: string;
  /** Optional default value (used when the form first renders). */
  defaultValue?: string;
  /** True if the field must be filled in. Defaults to true. */
  required?: boolean;
  /**
   * AXE-33 — conditional render. When set, only show this field if
   * the form's `field` value equals `equals`. Used by the HTTP
   * destination's auth-type selector to hide irrelevant inputs.
   */
  showWhen?: { field: string; equals: string };
}

export interface DestinationSchema {
  type: DestinationType;
  /**
   * False keeps legacy/existing rows readable/editable while removing the
   * destination from new-create flows.
   */
  availableForCreate?: boolean;
  /** Human label shown in the type selector. */
  label: string;
  /** One-sentence pitch for the type-selector card. */
  blurb: string;
  /** Glyph or initial used in the type-selector card (no images, all text). */
  glyph: string;
  /**
   * Optional note rendered when a type has no configurable fields, to explain
   * what (if anything) the user still needs to set. Pairs with SRC-DLG-15.
   */
  emptyStateNote?: string;
  fields: DestinationField[];
}

export const DESTINATION_SCHEMAS: DestinationSchema[] = [
  {
    type: "webhook",
    label: "Signed webhook",
    blurb: "POST events to any URL with HMAC signing, timestamps, and idempotency. Stripe-compatible signature format.",
    glyph: "⌬",
    fields: [
      {
        key: "url",
        label: "Receiver URL",
        hint: "Where Axel sends the signed POST. HTTPS is required for production — HTTP sends signed payloads in the clear.",
        kind: "config",
        inputType: "url",
        placeholder: "https://api.customer.com/webhooks/axel",
        required: true,
      },
      {
        key: "signing_algorithm",
        label: "Signing algorithm",
        hint: "HMAC-SHA256 is the default; SHA512 is supported for receivers that require it.",
        kind: "config",
        inputType: "select",
        defaultValue: "hmac-sha256",
        required: false,
        options: [
          { value: "hmac-sha256", label: "HMAC-SHA256" },
          { value: "hmac-sha512", label: "HMAC-SHA512" },
        ],
      },
      {
        key: "method",
        label: "HTTP method",
        hint: "POST is the most common; PUT/PATCH supported.",
        kind: "config",
        inputType: "select",
        defaultValue: "POST",
        required: false,
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
        ],
      },
      {
        key: "signing_secret",
        label: "Signing secret",
        hint: "Leave blank to auto-generate. Stored encrypted; shown once after creation. Receivers verify HMAC of `<timestamp>.<body>`.",
        kind: "secret",
        inputType: "password",
        placeholder: "(leave blank — Axel will generate one)",
        required: false,
      },
    ],
  },
  {
    type: "http",
    label: "HTTP",
    blurb: "POST with bearer, API key, basic, or custom header auth. Built for Slack, Zapier, n8n, Make, and receivers that manage their own auth.",
    glyph: "↗",
    fields: [
      {
        key: "url",
        label: "Destination URL",
        hint: "Where Axel sends the POST. Use HTTPS for any auth mode other than \"No auth\" — plaintext HTTP exposes bearer tokens and API keys in transit.",
        kind: "config",
        inputType: "url",
        placeholder: "https://customer.example.com/in",
        required: true,
      },
      {
        key: "method",
        label: "HTTP method",
        hint: "POST is the most common; PUT/PATCH supported.",
        kind: "config",
        inputType: "select",
        defaultValue: "POST",
        required: false,
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
        ],
      },
      {
        key: "auth_type",
        label: "Auth mode",
        hint: "How Axel authenticates to the destination. Pick a preset; the matching fields appear below.",
        kind: "config",
        inputType: "select",
        defaultValue: "none",
        required: false,
        options: [
          { value: "none", label: "No auth (public webhook)" },
          { value: "bearer", label: "Bearer token (Authorization: Bearer …)" },
          { value: "basic", label: "Basic (Authorization: Basic …)" },
          { value: "api_key", label: "API key in custom header" },
          { value: "custom_headers", label: "Custom headers (raw KEY: VALUE)" },
        ],
      },
      {
        key: "bearer_token",
        label: "Bearer token",
        hint: "Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "password",
        required: false,
        showWhen: { field: "auth_type", equals: "bearer" },
      },
      {
        key: "basic_user",
        label: "Basic username",
        hint: "Plaintext username for Basic auth.",
        kind: "config",
        inputType: "text",
        required: false,
        showWhen: { field: "auth_type", equals: "basic" },
      },
      {
        key: "basic_password",
        label: "Basic password",
        hint: "Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "password",
        required: false,
        showWhen: { field: "auth_type", equals: "basic" },
      },
      {
        key: "api_key_header",
        label: "API key header name",
        hint: "e.g. X-API-Key, DD-API-KEY, Authorization (without 'Bearer ').",
        kind: "config",
        inputType: "text",
        defaultValue: "X-API-Key",
        required: false,
        showWhen: { field: "auth_type", equals: "api_key" },
      },
      {
        key: "api_key_value",
        label: "API key value",
        hint: "Stored encrypted; sent as the header value verbatim (no Bearer prefix).",
        kind: "secret",
        inputType: "password",
        required: false,
        showWhen: { field: "auth_type", equals: "api_key" },
      },
      {
        key: "custom_headers",
        label: "Custom headers",
        hint: "One per line, `Header-Name: value`. Use for HMAC, signed-request, or proprietary auth schemes.",
        kind: "secret",
        inputType: "text",
        placeholder: "X-Signature: ...\nX-Timestamp: ...",
        required: false,
        showWhen: { field: "auth_type", equals: "custom_headers" },
      },
      {
        key: "preset",
        label: "Preset (optional)",
        hint: "Picking a preset prefills the auth mode (and header name) above for that target. Review the auth fields before saving.",
        kind: "config",
        inputType: "select",
        defaultValue: "generic",
        required: false,
        options: [
          { value: "generic", label: "Generic HTTP target" },
          { value: "slack", label: "Slack incoming webhook (paste URL, no auth)" },
          { value: "discord", label: "Discord webhook (paste URL, no auth)" },
          { value: "teams", label: "Microsoft Teams incoming webhook (paste URL, no auth)" },
          { value: "pagerduty", label: "PagerDuty Events v2 (paste URL, optional integration key in auth)" },
          { value: "datadog", label: "Datadog events (api_key auth header)" },
          { value: "zapier", label: "Zapier catch hook (paste URL)" },
          { value: "n8n", label: "n8n webhook (paste URL)" },
          { value: "make", label: "Make.com webhook (paste URL)" },
        ],
      },
    ],
  },
  {
    type: "mongodb",
    label: "MongoDB",
    blurb: "Insert each event document into a MongoDB collection. Supports Atlas and any replica set. Pick or create a target collection when wiring a route.",
    glyph: "M",
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        hint: "mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true. Stored encrypted; not visible after save. Allow Axel's egress IPs under Atlas → Network Access (or 0.0.0.0/0 to allow all).",
        kind: "secret",
        inputType: "password",
        placeholder: "mongodb+srv://USER:PASS@cluster.mongodb.net/",
        required: true,
      },
      {
        key: "database",
        label: "Database",
        hint: "Atlas database name. Collection is chosen per route.",
        kind: "config",
        placeholder: "axel_events",
        required: true,
      },
    ],
  },
  {
    type: "postgres",
    label: "Postgres",
    blurb: "INSERT each event into your table. Pick or create a table when wiring a route — JSONB blob or auto dot-notation columns.",
    glyph: "P",
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        hint: "postgres://user:pass@host:5432/db. Stored encrypted; not visible after save. Table is chosen per route. Allow Axel's egress IPs in your database firewall / IP allowlist.",
        kind: "secret",
        inputType: "password",
        placeholder: "postgresql://user:pass@host:5432/dbname",
        required: true,
      },
    ],
  },
  {
    type: "s3",
    label: "S3",
    blurb: "Store events as JSON files (one per event) or batched Parquet — you choose the format per route when you wire this destination into a pipeline. Set a key prefix per route (e.g. events/) to namespace files; template variables {date} and {event_id} are supported.",
    glyph: "S",
    fields: [
      {
        key: "bucket",
        label: "Bucket name",
        kind: "config",
        placeholder: "customer-archive",
        required: true,
      },
      {
        key: "region",
        label: "Region",
        hint: "AWS region for signing. For S3-compatible providers, use the region they document; Tigris uses auto.",
        kind: "config",
        placeholder: "us-east-1",
        required: true,
      },
      {
        key: "endpoint",
        label: "Endpoint URL",
        hint: "Optional S3-compatible endpoint. Leave blank for AWS S3. For Tigris, use https://t3.storage.dev.",
        kind: "config",
        inputType: "url",
        placeholder: "https://t3.storage.dev",
        required: false,
      },
      {
        key: "addressing_style",
        label: "Endpoint addressing",
        hint: "Only used with a custom endpoint. Choose virtual-hosted for Tigris; path-style works for many MinIO-compatible services.",
        kind: "config",
        inputType: "select",
        defaultValue: "path",
        required: false,
        options: [
          { value: "path", label: "Path-style: endpoint/bucket/key" },
          { value: "virtual_hosted", label: "Virtual-hosted: bucket.endpoint/key (Tigris)" },
        ],
      },
      {
        key: "access_key_id",
        label: "AWS access key id",
        hint: "s3:PutObject on arn:aws:s3:::YOUR-BUCKET-NAME/* (replace YOUR-BUCKET-NAME with the bucket above). Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "password",
        placeholder: "AKIA…",
        required: true,
      },
      {
        key: "secret_access_key",
        label: "AWS secret access key",
        kind: "secret",
        inputType: "password",
        required: true,
      },
    ],
  },
  {
    type: "r2",
    label: "Cloudflare R2",
    blurb: "Store each event as a JSON file in Axel's managed Cloudflare R2 bucket — no AWS account or credentials needed. Events are isolated by the key prefix you set per route.",
    glyph: "R",
    emptyStateNote: "Axel manages the R2 bucket — no credentials needed. Set an optional key prefix to namespace your events when you wire this destination to a route (on the route's Destinations tab).",
    fields: [],
  },
  {
    type: "databricks_sql",
    availableForCreate: false,
    label: "Databricks (SQL Warehouse)",
    blurb: "INSERT each event into a Delta table via a SQL Warehouse. Simple, but caps at low/moderate volume — every event is its own Delta commit.",
    glyph: "D",
    fields: [
      {
        key: "workspace_host",
        label: "Workspace host",
        hint: "Your Databricks workspace hostname, no scheme. e.g. dbc-12345abc-de67.cloud.databricks.com.",
        kind: "config",
        placeholder: "dbc-12345abc-de67.cloud.databricks.com",
        required: true,
      },
      {
        key: "warehouse_id",
        label: "SQL warehouse ID",
        hint: "From SQL Warehouses → Connection details. e.g. 1234567890abcdef.",
        kind: "config",
        placeholder: "1234567890abcdef",
        required: true,
      },
      {
        key: "catalog",
        label: "Catalog",
        hint: "Unity Catalog catalog name. Table is chosen per route.",
        kind: "config",
        placeholder: "main",
        defaultValue: "main",
        required: true,
      },
      {
        key: "schema_name",
        label: "Schema",
        hint: "Unity Catalog schema (database) name.",
        kind: "config",
        placeholder: "default",
        defaultValue: "default",
        required: true,
      },
      {
        key: "access_token",
        label: "Access token",
        hint: "Databricks personal access token or service principal token. Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "password",
        placeholder: "dapi…",
        required: true,
      },
    ],
  },
  {
    type: "databricks_volume",
    label: "Databricks Volume (Auto Loader)",
    blurb: "Drop JSON files into a Unity Catalog Volume. Point Auto Loader at it for streaming ingest into Delta. Scales horizontally — the recommended pattern for high volume.",
    glyph: "D",
    fields: [
      {
        key: "workspace_host",
        label: "Workspace host",
        hint: "Your Databricks workspace hostname, no scheme.",
        kind: "config",
        placeholder: "dbc-12345abc-de67.cloud.databricks.com",
        required: true,
      },
      {
        key: "catalog",
        label: "Catalog",
        kind: "config",
        placeholder: "main",
        defaultValue: "main",
        required: true,
      },
      {
        key: "schema_name",
        label: "Schema",
        kind: "config",
        placeholder: "default",
        defaultValue: "default",
        required: true,
      },
      {
        key: "access_token",
        label: "Access token",
        hint: "Databricks personal access token or service principal token. Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "password",
        placeholder: "dapi…",
        required: true,
      },
    ],
  },
  {
    type: "bigquery",
    label: "Google BigQuery",
    blurb: "Stream each event into a BigQuery dataset + table chosen per route, using one project/service-account connection. Nested RECORD fields are the default, and the event id is the streaming insertId so re-deliveries dedupe.",
    glyph: "BQ",
    fields: [
      {
        key: "project_id",
        label: "Project ID",
        hint: "The GCP project that owns the dataset. e.g. my-analytics-prod.",
        kind: "config",
        placeholder: "my-analytics-prod",
        required: true,
      },
      {
        key: "service_account_json",
        label: "Service account key (JSON)",
        hint: "Paste the full service-account key JSON. Needs BigQuery Data Editor on every target dataset (Axel auto-creates tables and additively evolves nested RECORD / REPEATED schemas). Stored encrypted; not visible after save.",
        kind: "secret",
        inputType: "textarea",
        placeholder: '{"type":"service_account","project_id":"…","private_key":"…"}',
        required: true,
      },
    ],
  },
];

export const CREATABLE_DESTINATION_SCHEMAS = DESTINATION_SCHEMAS.filter(
  (schema) => schema.availableForCreate !== false,
);

export function schemaFor(type: DestinationType): DestinationSchema {
  const found = DESTINATION_SCHEMAS.find((s) => s.type === type);
  if (!found) throw new Error(`Unknown destination type: ${type}`);
  return found;
}

/**
 * AXE-33 — shared `showWhen` evaluation. A field with no condition is always
 * visible; a conditional field is visible only while its controlling field's
 * current value matches. Used by the client-side field renderer (create
 * dialog + edit form) AND the update action (which drops a stored config
 * value once its controlling value stops matching, mirroring the fact that
 * the form never submits a hidden field).
 */
export function isDestinationFieldVisible(
  field: Pick<DestinationField, "showWhen">,
  values: Record<string, unknown>,
): boolean {
  if (!field.showWhen) return true;
  return values[field.showWhen.field] === field.showWhen.equals;
}

/**
 * Field values implied by each HTTP `preset` option. Picking a preset in the
 * create/edit form applies these on top of whatever the operator already
 * entered (the operator can still adjust afterwards — the auth fields stay
 * fully editable). Keys must be `kind: "config"` field keys of the http
 * schema; the delivery runtimes expand auth_type/api_key_header into request
 * headers via @axel/shared buildHttpAuthConfig.
 *
 * Most targets are paste-the-URL webhooks where the secret is embedded in the
 * URL itself, so their implied auth mode is "none". Datadog is the one target
 * that authenticates via a fixed API-key header.
 */
export const HTTP_PRESET_FIELD_DEFAULTS: Record<string, Record<string, string>> = {
  generic: {},
  slack: { auth_type: "none" },
  discord: { auth_type: "none" },
  teams: { auth_type: "none" },
  // Events v2 routing keys ride in the payload/URL; header auth is optional
  // and stays operator-configured.
  pagerduty: { auth_type: "none" },
  datadog: { auth_type: "api_key", api_key_header: "DD-API-KEY" },
  zapier: { auth_type: "none" },
  n8n: { auth_type: "none" },
  make: { auth_type: "none" },
};

/**
 * Shared setter logic for the schema-driven destination forms: merge a single
 * field edit into the tracked values, and — when the edited field is the HTTP
 * `preset` selector — also apply that preset's implied field values so the
 * selector actually configures something rather than being a stored-but-inert
 * label (audit: http-preset-field-is-inert).
 */
export function applyDestinationFieldValue(
  prev: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  const implied = key === "preset" ? HTTP_PRESET_FIELD_DEFAULTS[value] : undefined;
  return { ...prev, ...implied, [key]: value };
}

/**
 * Validate every submitted `select`-kind value against the schema's allowed
 * options. Downstream connectors treat unknown enum values as silent
 * fallbacks — e.g. the webhook signer runs SHA-256 for any algorithm string
 * other than exactly "hmac-sha512" — so a stored typo ("sha512") breaks HMAC
 * verification at the receiver with no error anywhere. Reject it loudly at
 * save time instead. Empty/absent values are skipped (required-ness is
 * enforced separately). Returns a human-readable error or null.
 */
export function destinationSelectOptionsError(
  type: DestinationType,
  values: Record<string, unknown>,
): string | null {
  const schema = schemaFor(type);
  for (const field of schema.fields) {
    if (field.inputType !== "select" || !field.options) continue;
    const value = values[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (!field.options.some((opt) => opt.value === value)) {
      const allowed = field.options.map((opt) => opt.value).join(", ");
      return `${field.label} must be one of: ${allowed}.`;
    }
  }
  return null;
}
