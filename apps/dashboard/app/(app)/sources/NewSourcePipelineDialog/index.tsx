"use client";

import * as React from "react";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { SourceProvider } from "@axel/shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, TriangleAlert } from "lucide-react";
import {
  createSourceWithPipeline,
  listActiveDestinationsForPicker,
} from "../../../../lib/first-run-actions";
import type { ActionState } from "../../../../lib/action-data";
import { testNewDestinationConnection } from "../../../../lib/test-destination";
import { CREATABLE_DESTINATION_SCHEMAS } from "../../../../lib/destination-defaults";
import { defaultPipelineName } from "../../../../lib/entity-name";
import {
  sourceAuthenticationCopy,
  sourceUsesAxelToken,
} from "../../../../lib/source-ingest-auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ConfirmAction } from "../../../_components/ConfirmAction";
import {
  BINDING_REQUIRED_TYPES,
  bindingMissingMessage,
  isCompleteJsonObject,
  type DestinationMode,
  type ExistingDestination,
} from "./helpers";
import {
  InboundProviderFields,
  SecretRow,
  SigningSecretHint,
  StepDots,
} from "./steps/shared";
import { SourceStep } from "./steps/SourceStep";
import { DestinationStep } from "./steps/DestinationStep";
import { ReviewStep } from "./steps/ReviewStep";
import { ActivationStep } from "./steps/ActivationStep";

// Re-exported for FirstRunSetupFlow, which shares the one-shot-secret and
// provider-preset UI with this wizard.
export { InboundProviderFields, SecretRow, SigningSecretHint };

export function NewSourcePipelineDialog({
  disabledReason,
  existingDestinations: initialDestinations,
  trigger,
  autoOpenOnCreateParam = true,
}: {
  disabledReason?: string;
  existingDestinations: ExistingDestination[];
  trigger?: React.ReactNode;
  /**
   * Whether this instance auto-opens on `?create=1`. Defaults true. A page
   * can render two instances (e.g. the header action AND an empty-state card);
   * only one should respond to the deep-link param, so the card instance
   * passes false to avoid both dialogs opening at once.
   */
  autoOpenOnCreateParam?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  // Close-guard for un-copied one-shot secrets (see handleOpenChange).
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  // The page passes destinations once at render time. If the user creates
  // a destination in another tab, that prop goes stale; we refresh on every
  // dialog-open via listActiveDestinationsForPicker so the picker reflects
  // current workspace state.
  const [existingDestinations, setExistingDestinations] =
    useState<ExistingDestination[]>(initialDestinations);
  const [destinationMode, setDestinationMode] = useState<DestinationMode>(
    initialDestinations.length > 0 ? "existing" : "new",
  );
  const [newDestinationType, setNewDestinationType] = useState<string>(
    CREATABLE_DESTINATION_SCHEMAS[0]?.type ?? "webhook",
  );
  // Controlled selection for the existing-destinations picker. Using
  // `defaultValue` would keep pointing at a deleted destination after the
  // refresh effect replaces the list — the user would silently submit a
  // stale id.
  const [pickedExistingDestId, setPickedExistingDestId] = useState<string>(
    initialDestinations[0]?.id ?? "",
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createSourceWithPipeline,
    {},
  );
  const [destConnState, destConnAction, destConnPending] = useActionState<ActionState, FormData>(
    testNewDestinationConnection,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  // AXE-56 — controlled source name + a hint string from the
  // bootstrap panel. Controlled (rather than defaultValue) so the
  // panel's "Use this preset" can replace the input value
  // unconditionally when the user clicks it.
  const [sourceName, setSourceName] = useState("");
  const [sourceProvider, setSourceProvider] = useState<SourceProvider>("custom");
  // Pipeline (route) name — required whenever a destination is attached. Controlled
  // so it survives the React-19 form reset the wizard fights elsewhere.
  const [pipelineName, setPipelineName] = useState("");
  // BigQuery guided target (new-destination path): dataset + table combine into
  // the hidden `new_destination_target` the server parses as `dataset.table`.
  const [bqDataset, setBqDataset] = useState("");
  const [bqTable, setBqTable] = useState("");
  // Live values of the new-destination credential fields, so the BigQuery picker
  // can auto-load datasets the moment the service-account token is entered.
  const [destFieldValues, setDestFieldValues] = useState<Record<string, string>>({});
  // Signature of the entered BigQuery credentials — non-null only once the
  // project id is present and the service-account JSON parses (so we don't hit
  // the API mid-paste). Drives the picker's auto-load; changes when creds change.
  const bqCredentialsKey = useMemo(() => {
    if (newDestinationType !== "bigquery") return null;
    const projectId = (destFieldValues.project_id ?? "").trim();
    const serviceAccountJson = (destFieldValues.service_account_json ?? "").trim();
    if (!projectId || !isCompleteJsonObject(serviceAccountJson)) return null;
    return `${projectId}::${serviceAccountJson}`;
  }, [newDestinationType, destFieldValues]);

  function readFormValue(name: string): string {
    if (!formRef.current) return "";
    const fd = new FormData(formRef.current);
    return String(fd.get(name) ?? "").trim();
  }

  function validateStep1(): string | null {
    const name = readFormValue("source_name");
    if (!name) return "Source name is required.";
    if (name.length < 2 || name.length > 64) return "Source name must be 2–64 characters.";
    const provider = readFormValue("inbound_provider");
    if (provider && provider !== "custom" && !readFormValue("inbound_signing_secret")) {
      const labels: Record<string, string> = {
        stripe: "Stripe",
        github: "GitHub",
        shopify: "Shopify",
        chargebee: "Chargebee",
      };
      return `${labels[provider] ?? provider} signing secret is required.`;
    }
    return null;
  }

  function validateStep2(): string | null {
    if (destinationMode === "skip") return null;
    if (destinationMode === "existing") {
      const pickedId = readFormValue("existing_destination_id");
      if (!pickedId) return "Pick an existing destination or switch to New.";
      // Container-shaped destinations need a binding (table/collection/
      // volume) before the first event can land. Block here so the
      // operator picks it up-front rather than after a failed delivery.
      const picked = existingDestinations.find((d) => d.id === pickedId);
      if (picked && BINDING_REQUIRED_TYPES.has(picked.type)) {
        const bindingRaw = readFormValue(`binding:${pickedId}`);
        if (!bindingRaw) {
          return bindingMissingMessage(picked.type);
        }
      }
      return null;
    }
    // mode === "new"
    if (!readFormValue("new_destination_name")) return "Destination name is required.";
    const schema = CREATABLE_DESTINATION_SCHEMAS.find((s) => s.type === newDestinationType);
    if (!schema) return "Pick a destination type.";
    for (const field of schema.fields) {
      if (field.required === false) continue;
      if (!readFormValue(`dest_field_${field.key}`)) return `Missing required field: ${field.label}.`;
    }
    // HTTP auth: the chosen auth mode must carry its credential. Those fields
    // are conditionally shown (showWhen), so the required-field loop above
    // skips them — enforce the pairing here so the user fixes it before submit
    // rather than after a silent 401 on the first delivery.
    if (newDestinationType === "http") {
      const authType = readFormValue("dest_field_auth_type") || "none";
      if (authType === "bearer" && !readFormValue("dest_field_bearer_token")) {
        return "Bearer token is required for Bearer auth.";
      }
      if (
        authType === "basic" &&
        (!readFormValue("dest_field_basic_user") || !readFormValue("dest_field_basic_password"))
      ) {
        return "Basic auth requires both a username and a password.";
      }
      if (
        authType === "api_key" &&
        (!readFormValue("dest_field_api_key_header") || !readFormValue("dest_field_api_key_value"))
      ) {
        return "API key auth requires both a header name and a key value.";
      }
      if (authType === "custom_headers" && !readFormValue("dest_field_custom_headers")) {
        return "Custom-header auth requires at least one header line (KEY: VALUE).";
      }
    }
    // Table-shaped destinations need a target (table/collection/volume) or the
    // route can't deliver — same guard the existing-destination branch applies.
    if (BINDING_REQUIRED_TYPES.has(newDestinationType) && !readFormValue("new_destination_target")) {
      return bindingMissingMessage(newDestinationType);
    }
    // Databricks volume names must be a bare lowercase identifier (the worker
    // interpolates them into /Volumes/{catalog}/{schema}/{volume}/). Reject a
    // full path or uppercase/special chars before they fail server-side.
    if (newDestinationType === "databricks_volume") {
      const volume = readFormValue("new_destination_target");
      // Match the delivery runtime's SAFE_IDENT (apps/delivery-service
      // connectors/databricks.ts) so we don't reject a bare name the worker
      // would happily accept (uppercase, leading underscore, and hyphens are
      // all valid in a Unity Catalog volume name).
      if (volume && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(volume)) {
        return "Databricks volume name must be a bare name — letters, numbers, underscores, or hyphens (e.g. webhooks_landing), not a path.";
      }
    }
    return null;
  }

  function continueToStep(next: 2 | 3) {
    const err = next === 2 ? validateStep1() : (validateStep1() ?? validateStep2());
    if (err) {
      setStepError(err);
      return;
    }
    // Arriving at the review step with no pipeline name yet: default it from
    // the source name so the user isn't forced to invent one. Editable there.
    if (next === 3 && destinationMode !== "skip" && !pipelineName.trim()) {
      const source = readFormValue("source_name");
      if (source) setPipelineName(defaultPipelineName(source));
    }
    setStepError(null);
    setStep(next);
  }

  // Soft, non-blocking verification nudge. We deliberately do NOT gate Continue
  // on a passing test — firewalled destinations and restricted dashboard egress
  // legitimately can't always probe from here. Instead we surface an amber note
  // so a typo'd credential is caught now rather than failing silently on the
  // first delivery. Returns null when there's nothing to verify, a test is
  // already running, or a result (success notice or error) is already shown.
  // (Webhook sources have no pre-create connection test, so step 1 never warns.)
  function unverifiedConnectionWarning(): string | null {
    if (step === 2 && destinationMode === "new" && !["r2", "s3"].includes(newDestinationType)) {
      return destConnState.notice || destConnState.error || destConnPending
        ? null
        : "Destination connection not verified — Test it before continuing to catch credential errors early. You can continue without testing.";
    }
    return null;
  }

  const selectedDestSchema = CREATABLE_DESTINATION_SCHEMAS.find((s) => s.type === newDestinationType);

  // The id of a source created during THIS open session. Tracked separately
  // from the persistent useActionState `state` (which lingers across
  // close/reopen on the long-lived header/dashboard instances), so a reopened
  // wizard starts clean: gating the post-success UI on `created` — not on the
  // stale `state.data.sourceId` — lets a second source be created and stops
  // already-copied secrets from reappearing. Cleared in reset() on close.
  const [createdSourceId, setCreatedSourceId] = useState<string | null>(null);
  const created = createdSourceId !== null;

  // The response carries one-shot secrets (ingest token / signing secret) that
  // the user MUST copy before closing the dialog. Only "live" once a source was
  // created this session, so a stale `state` on reopen can't re-trigger the
  // close guard or re-render the secrets.
  const hasOneShotSecret = created && Boolean(
    (sourceUsesAxelToken(sourceProvider) && state.data?.plaintextToken)
      || state.data?.webhookSigningSecret,
  );
  useEffect(() => {
    if (state.notice && state.data?.sourceId && !pending) {
      setCreatedSourceId(state.data.sourceId);
      // Land the user on the activation step to close the loop (send a test
      // event / view sync status) instead of auto-closing. When the source
      // returned a one-shot secret, we stay put so the user copies it first,
      // then advances via "Continue to test →". Named-provider sources do not
      // return an Axel token and can jump straight to activation.
      //
      // NOTE: the page-list refresh is DEFERRED to dialog-close (see
      // handleOpenChange) — refreshing here would re-render the server page and
      // unmount this dialog while it's still open inside an empty-state branch.
      const oneShot = Boolean(
        (sourceUsesAxelToken(sourceProvider) && state.data.plaintextToken)
          || state.data.webhookSigningSecret,
      );
      if (!oneShot) setStep(4);
    }
  }, [state, pending, sourceProvider]);

  // Clear the step-transition error whenever the user changes a relevant
  // selector — otherwise a "Destination name is required" message lingers
  // after they switch the destination mode or type.
  useEffect(() => {
    setStepError(null);
  }, [destinationMode, newDestinationType]);

  useEffect(() => {
    if (autoOpenOnCreateParam && searchParams.get("create") === "1" && !disabledReason) {
      setOpen(true);
    }
  }, [autoOpenOnCreateParam, disabledReason, searchParams]);

  function reset() {
    setStep(1);
    setPipelineName("");
    setBqDataset("");
    setBqTable("");
    setDestinationMode(existingDestinations.length > 0 ? "existing" : "new");
    // Clear session-scoped creation state so a reopened wizard starts fresh
    // (the persistent instances never unmount, so this won't happen on its own).
    setCreatedSourceId(null);
    setSourceName("");
    setSourceProvider("custom");
  }

  function clearCreateParam() {
    if (searchParams.get("create") !== "1") return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("create");
    const suffix = nextParams.toString();
    router.replace(`/sources${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }

  // Re-fetch destinations every time the dialog opens, so picks reflect any
  // destinations created in another tab. We swallow errors silently and fall
  // back to the prop value the page already passed in.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listActiveDestinationsForPicker()
      .then((rows) => {
        if (cancelled) return;
        setExistingDestinations(rows);
        // Auto-flip mode to "new" if the workspace turns out to have no
        // destinations and we previously defaulted to "existing".
        if (rows.length === 0 && destinationMode === "existing") {
          setDestinationMode("new");
        }
        // If the currently-picked id is gone from the refreshed list,
        // snap to the new first option.
        if (rows.length > 0 && !rows.some((r) => r.id === pickedExistingDestId)) {
          setPickedExistingDestId(rows[0]!.id);
        }
      })
      .catch(() => {
        // Stale prop is still better than a crash here.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleOpenChange(next: boolean) {
    // When closing, guard against losing one-shot secrets the user hasn't
    // copied yet. Ingest tokens and signing secrets are shown ONCE and are
    // unrecoverable; an accidental Esc / X click would force the user to
    // rotate them via the source/destination detail pages.
    if (!next && hasOneShotSecret) {
      setConfirmCloseOpen(true);
      return;
    }
    setOpen(next);
    if (!next) {
      // Deferred from the success handler: refresh the page's source/destination
      // lists now that the dialog is closing, so a server re-render can't unmount
      // an open empty-state-gated dialog mid-flow. Only needed if we created one.
      if (createdSourceId) router.refresh();
      reset();
      clearCreateParam();
    }
  }

  // Form fields not in the active step are hidden but still submitted; this
  // keeps the user's typed values across step transitions without
  // round-tripping through React state for every input.
  const stepCls = (n: 1 | 2 | 3 | 4) => (step === n ? "" : "hidden");

  return (
    <>
    <ConfirmAction
      open={confirmCloseOpen}
      onOpenChange={setConfirmCloseOpen}
      title="Close and lose secrets"
      body="Close and lose the displayed secrets? They can't be retrieved again."
      confirmLabel="Close anyway"
      cancelLabel="Keep open"
      destructive
      onConfirm={() => {
        setOpen(false);
        if (createdSourceId) router.refresh();
        reset();
        clearCreateParam();
      }}
    />
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={Boolean(disabledReason)} title={disabledReason}>
            <Plus className="size-4" />
            New source
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New source</DialogTitle>
          <DialogDescription>
            Create a source, optionally attach it to a destination through a route — all in one step.
          </DialogDescription>
        </DialogHeader>

        <StepDots
          step={step}
          created={created}
          pending={pending}
          onGoToStep={(n) => {
            setStepError(null);
            setStep(n);
          }}
        />

        <form
          action={formAction}
          ref={formRef}
          // Hidden (not unmounted) on step 4 so all field state survives a
          // "Back" from the activation step; the activation step renders as a
          // sibling of this form, never nested inside it.
          className={step === 4 ? "hidden" : "space-y-5"}
          onSubmit={(e) => {
            // Pressing Enter in any input submits the form via its default
            // action (the pipeline). Block that when we're not on the final
            // step — otherwise the user creates a half-configured pipeline
            // by accidentally hitting Enter on step 1 or 2.
            //
            // We only block when there's no explicit submitter, i.e. an Enter
            // press. Clicks on real submit buttons (Test, "Just create
            // source", "Create pipeline") set submitter and must go through.
            const submitter = (e.nativeEvent as SubmitEvent).submitter;
            // Block bare-Enter submits off the final step, and once the
            // pipeline already exists this session (prevents a duplicate create
            // if the user hits Enter back on step 3 after success).
            if (!submitter && (step !== 3 || created)) e.preventDefault();
          }}
          onKeyDown={(e) => {
            // A bare Enter in a textarea should still insert a newline; only
            // block on inputs to mirror normal HTML form behavior for the
            // final step.
            if (e.key !== "Enter") return;
            const target = e.target as HTMLElement | null;
            if (!target || target.tagName === "TEXTAREA") return;
            if (step !== 3) e.preventDefault();
          }}
        >
          <div className="space-y-2">
            {/* stepError (step-transition validation) renders next to the
                navigation buttons below, not here, so the reason a "Continue"
                click did nothing is visible right where the user clicked. */}
            {/* Only the create-pipeline error (state.error) lives at the top of
                the form. Per-kind SaaS test errors render inline next to the
                Test button (below) so they stay scoped to the credential being
                tested and don't outlive a source-kind switch. */}
            {[state.error]
              .filter((e): e is string => Boolean(e))
              .map((err) => (
                <Alert key={err} variant="destructive">
                  <AlertDescription>{err}</AlertDescription>
                </Alert>
              ))}
            {/* Per-kind test-success notices render inline next to the Test
                button (below) so credentials stay visible alongside the
                confirmation — clearing them was a recurring complaint
                (#151, #153). */}
            {created && state.notice ? (
              <Alert>
                <AlertDescription>
                  <div>{state.notice}</div>
                  {(sourceUsesAxelToken(sourceProvider) && state.data?.plaintextToken)
                    || state.data?.webhookSigningSecret ? (
                    <div
                      role="alert"
                      className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-foreground"
                    >
                      <TriangleAlert className="size-3.5 shrink-0 text-amber-600" />
                      <span>
                        Copy each secret below now. One-shot secrets cannot be retrieved after you
                        close this dialog.
                      </span>
                    </div>
                  ) : null}
                  {state.data?.ingestUrl ? (
                    <>
                      <SecretRow
                        label="Webhook URL — point your provider here"
                        value={state.data.ingestUrl}
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {sourceAuthenticationCopy(sourceProvider)}
                      </p>
                    </>
                  ) : null}
                  {sourceUsesAxelToken(sourceProvider) && state.data?.plaintextToken ? (
                    <SecretRow
                      label="Ingest token — send only as x-axel-token"
                      value={state.data.plaintextToken}
                    />
                  ) : null}
                  {state.data?.webhookSigningSecret ? (
                    <>
                      <SecretRow
                        label="Destination signing secret"
                        value={state.data.webhookSigningSecret}
                      />
                      <SigningSecretHint />
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          {/* Hidden controls so the server action gets all wizard state. */}
          <input type="hidden" name="source_kind" value="webhook" />
          <input type="hidden" name="destination_mode" value={destinationMode} />
          <input type="hidden" name="new_destination_type" value={newDestinationType} />

          {/* ---------- STEP 1: SOURCE ---------- */}
          <div className={stepCls(1) + " space-y-4"}>
            <SourceStep
              sourceName={sourceName}
              onSourceNameChange={setSourceName}
              provider={sourceProvider}
              onProviderChange={setSourceProvider}
            />
          </div>

          {/* ---------- STEP 2: DESTINATION ---------- */}
          <div className={stepCls(2) + " space-y-4"}>
            <DestinationStep
              existingDestinations={existingDestinations}
              destinationMode={destinationMode}
              onDestinationModeChange={setDestinationMode}
              pickedExistingDestId={pickedExistingDestId}
              onPickedExistingDestIdChange={setPickedExistingDestId}
              newDestinationType={newDestinationType}
              onNewDestinationTypeChange={setNewDestinationType}
              selectedDestSchema={selectedDestSchema}
              onDestFieldValuesChange={setDestFieldValues}
              bqDataset={bqDataset}
              bqTable={bqTable}
              onBqDatasetChange={setBqDataset}
              onBqTableChange={setBqTable}
              bqCredentialsKey={bqCredentialsKey}
              readFormValue={readFormValue}
              formRef={formRef}
              destConnState={destConnState}
              destConnAction={destConnAction}
              destConnPending={destConnPending}
            />
          </div>

          {/* ---------- STEP 3: ROUTE ---------- */}
          <div className={stepCls(3) + " space-y-4"}>
            <ReviewStep
              destinationMode={destinationMode}
              pipelineName={pipelineName}
              onPipelineNameChange={setPipelineName}
              sourceName={sourceName}
              existingDestinations={existingDestinations}
              pickedExistingDestId={pickedExistingDestId}
              selectedDestSchema={selectedDestSchema}
              newDestinationType={newDestinationType}
              readFormValue={readFormValue}
              onEditStep={(n) => {
                setStepError(null);
                setStep(n);
              }}
            />
          </div>

          {/* ---------- NAVIGATION ---------- */}
          {stepError ? (
            <Alert variant="destructive">
              <AlertDescription>{stepError}</AlertDescription>
            </Alert>
          ) : null}
          {/* Soft, non-blocking "connection not verified" nudge — see
              unverifiedConnectionWarning(). Suppressed once a test passes,
              fails, or is running, so it never competes with a real result. */}
          {(() => {
            const warning = unverifiedConnectionWarning();
            return warning ? (
              <Alert className="border-amber-500/50 text-amber-700 dark:border-amber-500/40 dark:text-amber-400 [&>svg]:text-amber-600">
                <AlertDescription className="text-amber-700 dark:text-amber-400">
                  {warning}
                </AlertDescription>
              </Alert>
            ) : null;
          })()}
          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={pending || step === 1}
              onClick={() => {
                setStepError(null);
                setStep(step === 3 ? 2 : 1);
              }}
            >
              Back
            </Button>

            <div className="flex items-center gap-2">
              {step === 1 ? (
                created ? (
                  // A custom source created via "Just create source" returned a
                  // one-shot token, so the success handler kept this step open.
                  // Give it a direct path to activation.
                  <Button type="button" disabled={pending} onClick={() => setStep(4)}>
                    Continue to test →
                  </Button>
                ) : (
                  <>
                    {/* The submit button writes its own name/value into FormData
                        when it triggers submission — more reliable than syncing
                        React state into a hidden input in the same event tick. */}
                    <Button
                      type="submit"
                      variant="outline"
                      name="action_intent"
                      value="skip"
                      disabled={pending}
                      onClick={(e) => {
                        // For the skip path we still need step-1 fields to be
                        // valid — but native HTML validation can't see our
                        // hidden step-2 inputs, so we use the same JS check the
                        // "Continue →" button uses.
                        const err = validateStep1();
                        if (err) {
                          e.preventDefault();
                          setStepError(err);
                        }
                      }}
                    >
                      Just create source
                    </Button>
                    <Button type="button" disabled={pending} onClick={() => continueToStep(2)}>
                      Continue →
                    </Button>
                  </>
                )
              ) : null}
              {step === 2 ? (
                <Button type="button" disabled={pending} onClick={() => continueToStep(3)}>
                  Continue →
                </Button>
              ) : null}
              {step === 3 ? (
                created ? (
                  // Pipeline already created (we paused here so a one-shot
                  // secret could be copied) — advance to the activation step.
                  <Button type="button" disabled={pending} onClick={() => setStep(4)}>
                    Continue to test →
                  </Button>
                ) : (
                  <Button type="submit" disabled={pending}>
                    {pending
                      ? "Creating…"
                      : destinationMode === "skip"
                      ? "Create source"
                      : "Create pipeline"}
                  </Button>
                )
              ) : null}
            </div>
          </div>
        </form>

        {/* ---------- STEP 4: ACTIVATE (sibling of the form, not nested) ---------- */}
        {step === 4 ? (
          <ActivationStep
            sourceId={createdSourceId ?? ""}
            ingestUrl={state.data?.ingestUrl}
            // The one-shot secrets also render on step 3, but that form is
            // display:none on step 4 — repeat them here so they stay copyable on
            // the go-live step (and the close guard below stays honest).
            plaintextToken={state.data?.plaintextToken}
            webhookSigningSecret={state.data?.webhookSigningSecret}
            sourceProvider={sourceProvider}
            // A route is created iff a destination was attached, and the server
            // only returns destinationId in that case. (Client `destinationMode`
            // is never "skip" — that decision is server-side via action_intent —
            // so we can't derive route-existence from it.)
            hasRoute={Boolean(state.data?.destinationId)}
            onBack={() => setStep(3)}
            onClose={() => handleOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
    </>
  );
}
