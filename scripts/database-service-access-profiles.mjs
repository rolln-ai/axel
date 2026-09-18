// Pure JSON helpers called by the SECURITY INVOKER data-contract triggers.
// Trigger execution itself needs no runtime EXECUTE grant; nested calls do.
export const DASHBOARD_DATABASE_ROUTINES = Object.freeze([
  "public.axel_scrub_data_contract_schema_node(jsonb)",
  "public.axel_scrub_data_contract_schema(jsonb)",
  "public.axel_strip_data_contract_previews(jsonb)",
  "public.axel_generalize_data_contract_fixture(jsonb)",
  "public.axel_data_contract_json_allowlist(jsonb,text[])",
]);

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const SEQUENCE_PRIVILEGES = Object.freeze(["USAGE"]);

export const DATABASE_SERVICE_PROFILE_NAMES = Object.freeze([
  "dashboard",
  "delivery-native",
  "delivery-workers",
  "pull-worker",
  "delivery-edge",
]);

export const APPLICATION_TABLES = Object.freeze([
  "pipeline_incidents",
  "alert_email_outbox",
  "admin_mfa_methods",
  "audit_log",
  "auth_rate_limits",
  "backfill_jobs",
  "billing_events",
  "billing_invoices",
  "component_heartbeat_history",
  "component_heartbeats",
  "data_contract_drift_events",
  "data_contract_fixtures",
  "data_contract_versions",
  "data_contracts",
  "dead_letter_mutes",
  "dead_letters",
  "delivery_canary_receipts",
  "delivery_idempotency",
  "destination_credentials",
  "destinations",
  "digest_sends",
  "email_verifications",
  "erasure_requests",
  "erasure_subjects",
  "notification_active_errors",
  "notification_preferences",
  "notifications",
  "password_resets",
  "personal_access_tokens",
  "pull_source_credentials",
  "pull_source_stream_state",
  "pull_sources",
  "pull_sync_runs",
  "queue_quarantine",
  "replay_jobs",
  "replay_requests",
  "route_destinations",
  "routes",
  "sources",
  "terms_acceptances",
  "user_sessions",
  "users",
  "workspace_api_keys",
  "workspace_invites",
  "workspace_members",
  "workspace_usage_period",
  "workspaces",
]);

export const APPLICATION_SEQUENCES = Object.freeze([
  "audit_log_id_seq",
  "data_contract_drift_events_id_seq",
  "dead_letters_id_seq",
  "erasure_subjects_id_seq",
  "queue_quarantine_id_seq",
]);

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function buildTables({ select = [], insert = [], update = [], delete: remove = [] }) {
  const result = {};
  for (const [privilege, tables] of [
    ["SELECT", select],
    ["INSERT", insert],
    ["UPDATE", update],
    ["DELETE", remove],
  ]) {
    for (const table of tables) {
      result[table] ??= [];
      result[table].push(privilege);
    }
  }
  return Object.fromEntries(
    Object.entries(result)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, privileges]) => [table, Object.freeze(sortedUnique(privileges))]),
  );
}

const dashboardInsert = [
  "pipeline_incidents",
  "alert_email_outbox",
  "admin_mfa_methods",
  "audit_log",
  "auth_rate_limits",
  "backfill_jobs",
  "billing_events",
  "billing_invoices",
  "data_contract_drift_events",
  "data_contract_fixtures",
  "data_contract_versions",
  "data_contracts",
  "dead_letter_mutes",
  "destination_credentials",
  "destinations",
  "digest_sends",
  "email_verifications",
  "erasure_requests",
  "notification_active_errors",
  "notification_preferences",
  "notifications",
  "password_resets",
  "personal_access_tokens",
  "pull_source_stream_state",
  "pull_sync_runs",
  "replay_jobs",
  "replay_requests",
  "route_destinations",
  "routes",
  "sources",
  "terms_acceptances",
  "user_sessions",
  "users",
  "workspace_api_keys",
  "workspace_invites",
  "workspace_members",
  "workspace_usage_period",
  "workspaces",
];

const dashboardUpdate = [
  "pipeline_incidents",
  "alert_email_outbox",
  "admin_mfa_methods",
  "auth_rate_limits",
  "backfill_jobs",
  "billing_events",
  "billing_invoices",
  "data_contract_drift_events",
  "data_contract_fixtures",
  "data_contracts",
  "dead_letter_mutes",
  "dead_letters",
  "destinations",
  "email_verifications",
  "erasure_requests",
  "notification_preferences",
  "notifications",
  "password_resets",
  "personal_access_tokens",
  "pull_source_stream_state",
  "pull_sync_runs",
  "replay_requests",
  "routes",
  "sources",
  "user_sessions",
  "users",
  "workspace_api_keys",
  "workspace_invites",
  "workspace_members",
  "workspace_usage_period",
  "workspaces",
];

const dashboardDelete = [
  "pipeline_incidents",
  "alert_email_outbox",
  "data_contract_drift_events",
  "data_contract_fixtures",
  "data_contracts",
  "dead_letters",
  "delivery_canary_receipts",
  "delivery_idempotency",
  "destinations",
  "digest_sends",
  "email_verifications",
  "erasure_subjects",
  "notification_active_errors",
  "password_resets",
  "pull_sources",
  "replay_requests",
  "route_destinations",
  "routes",
  "sources",
  "user_sessions",
  "workspace_invites",
  "workspace_members",
  "workspaces",
];

const dashboardSelect = sortedUnique([
  ...dashboardUpdate,
  ...dashboardDelete,
  "audit_log",
  "billing_events",
  "billing_invoices",
  "component_heartbeat_history",
  "component_heartbeats",
  "data_contract_versions",
  "destination_credentials",
  "pull_source_credentials",
  "replay_jobs",
]);

const PROFILES = {
  dashboard: {
    tables: buildTables({
      select: dashboardSelect,
      insert: dashboardInsert,
      update: dashboardUpdate,
      delete: dashboardDelete,
    }),
    sequences: {
      audit_log_id_seq: SEQUENCE_PRIVILEGES,
      data_contract_drift_events_id_seq: SEQUENCE_PRIVILEGES,
    },
  },
  "delivery-native": {
    tables: buildTables({
      select: [
        "destinations",
        "destination_credentials",
        "route_destinations",
        "routes",
        "sources",
        "replay_requests",
        "replay_jobs",
        "dead_letters",
        "queue_quarantine",
        "pull_sync_runs",
        "personal_access_tokens",
        "users",
        "workspaces",
        "workspace_members",
        "component_heartbeats",
        "delivery_idempotency",
        "notifications",
      ],
      insert: [
        "delivery_idempotency",
        "component_heartbeats",
        "queue_quarantine",
        "dead_letters",
        "audit_log",
        "notifications",
        "erasure_subjects",
      ],
      update: [
        "delivery_idempotency",
        "component_heartbeats",
        "queue_quarantine",
        "destinations",
        "routes",
        "replay_requests",
        "replay_jobs",
        "dead_letters",
        "notifications",
        "personal_access_tokens",
      ],
      delete: ["queue_quarantine"],
    }),
    sequences: {
      audit_log_id_seq: SEQUENCE_PRIVILEGES,
      dead_letters_id_seq: SEQUENCE_PRIVILEGES,
      erasure_subjects_id_seq: SEQUENCE_PRIVILEGES,
      queue_quarantine_id_seq: SEQUENCE_PRIVILEGES,
    },
  },
  "delivery-workers": {
    tables: buildTables({
      select: [
        "workspaces",
        "sources",
        "routes",
        "route_destinations",
        "destinations",
        "destination_credentials",
        "replay_requests",
        "replay_jobs",
        "backfill_jobs",
        "dead_letters",
        // Dead-letter triage respects operator mutes before auto-replaying.
        "dead_letter_mutes",
        "audit_log",
        "delivery_idempotency",
        "user_sessions",
        "workspace_invites",
        "notifications",
        "erasure_subjects",
        "component_heartbeats",
        "component_heartbeat_history",
      ],
      insert: [
        "replay_requests",
        "dead_letters",
        "notifications",
        "component_heartbeats",
        "component_heartbeat_history",
      ],
      update: [
        "replay_requests",
        "replay_jobs",
        "backfill_jobs",
        "routes",
        "component_heartbeats",
        "component_heartbeat_history",
        // Dead-letter triage stamps triage_* and auto_replay_id (migration 0078).
        "dead_letters",
      ],
      delete: [
        "dead_letters",
        "replay_requests",
        "audit_log",
        "delivery_idempotency",
        "user_sessions",
        "workspace_invites",
        "notifications",
        "erasure_subjects",
        "component_heartbeat_history",
      ],
    }),
    sequences: { dead_letters_id_seq: SEQUENCE_PRIVILEGES },
  },
  "pull-worker": {
    tables: buildTables({
      select: [
        "pull_sources",
        "sources",
        "pull_source_credentials",
        "pull_sync_runs",
        "pull_source_stream_state",
        "component_heartbeats",
      ],
      insert: ["pull_sync_runs", "pull_source_stream_state", "component_heartbeats"],
      update: ["pull_sync_runs", "pull_source_stream_state", "component_heartbeats"],
    }),
    sequences: {},
  },
  "delivery-edge": {
    tables: buildTables({
      select: ["destinations", "destination_credentials", "delivery_idempotency", "notifications"],
      insert: ["delivery_idempotency", "dead_letters", "audit_log", "notifications"],
      update: ["delivery_idempotency", "notifications", "destinations"],
    }),
    sequences: {
      audit_log_id_seq: SEQUENCE_PRIVILEGES,
      dead_letters_id_seq: SEQUENCE_PRIVILEGES,
    },
  },
};

for (const [profileName, profile] of Object.entries(PROFILES)) {
  for (const [table, privileges] of Object.entries(profile.tables)) {
    if (!APPLICATION_TABLES.includes(table)) {
      throw new Error(`database_service_profile_unknown_table_${profileName}`);
    }
    if (privileges.some((privilege) => !TABLE_PRIVILEGES.includes(privilege))) {
      throw new Error(`database_service_profile_invalid_table_privilege_${profileName}`);
    }
  }
  for (const [sequence, privileges] of Object.entries(profile.sequences)) {
    if (!APPLICATION_SEQUENCES.includes(sequence)) {
      throw new Error(`database_service_profile_unknown_sequence_${profileName}`);
    }
    if (privileges.some((privilege) => !SEQUENCE_PRIVILEGES.includes(privilege))) {
      throw new Error(`database_service_profile_invalid_sequence_privilege_${profileName}`);
    }
  }
  Object.freeze(profile.tables);
  Object.freeze(profile.sequences);
  Object.freeze(profile);
}

export const DATABASE_SERVICE_ACCESS_PROFILES = Object.freeze(PROFILES);

export function databaseServiceAccessProfile(name) {
  if (!DATABASE_SERVICE_PROFILE_NAMES.includes(name)) {
    throw new Error("database_service_profile_invalid");
  }
  return DATABASE_SERVICE_ACCESS_PROFILES[name];
}

export function expectedTablePrivilegeRows(name) {
  const profile = databaseServiceAccessProfile(name);
  return Object.entries(profile.tables).flatMap(([relation, privileges]) =>
    privileges.map((privilege) => ({ relation, privilege })),
  );
}

export function expectedSequencePrivilegeRows(name) {
  const profile = databaseServiceAccessProfile(name);
  return Object.entries(profile.sequences).flatMap(([relation, privileges]) =>
    privileges.map((privilege) => ({ relation, privilege })),
  );
}
