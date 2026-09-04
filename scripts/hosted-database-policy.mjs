export const HOSTED_CANARY_POLICY = Object.freeze({
  role: "axel_delivery_canary_writer",
  table: "delivery_canary_receipts",
  column: "payload",
  connectionLimit: 4,
  roleSettings: Object.freeze([
    "search_path=pg_catalog, public",
    "statement_timeout=10s",
    "idle_in_transaction_session_timeout=15s",
  ]),
});
