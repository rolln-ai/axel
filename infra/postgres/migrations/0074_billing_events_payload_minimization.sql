-- billing_events is an idempotency and processing journal. It must never retain
-- Stripe webhook bodies or billing-email task metadata. Install the guard before
-- scrubbing existing rows so migration-first rollouts also protect old writers.
CREATE OR REPLACE FUNCTION public.axel_minimize_billing_event_payload()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  NEW.payload := '{}'::pg_catalog.jsonb;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.axel_minimize_billing_event_payload()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS billing_events_payload_minimization_guard
  ON public.billing_events;
CREATE TRIGGER billing_events_payload_minimization_guard
BEFORE INSERT OR UPDATE OF payload ON public.billing_events
FOR EACH ROW
EXECUTE FUNCTION public.axel_minimize_billing_event_payload();

UPDATE public.billing_events
   SET payload = '{}'::jsonb
 WHERE payload <> '{}'::jsonb;

ALTER TABLE public.billing_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
