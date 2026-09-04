CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC;

DO $axel$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'axel_runtime'
  ) THEN
    REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM axel_runtime;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'axel_verify'
  ) THEN
    REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM axel_verify;
  END IF;
END
$axel$;
