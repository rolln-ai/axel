"use client";

import { WebhookSetupDetails } from "../../_components/WebhookSetupDetails";

import * as React from "react";
import { useActionState, useEffect, useRef, useState } from "react";
import type { SourceProvider } from "@axel/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Radio, TriangleAlert } from "lucide-react";
import {
  connectFirstDestination,
  createSourceWithPipeline,
  getFirstRunBackfillStatus,
} from "../../../lib/first-run-actions";
import { getRecentIngestEvents, type RecentIngestEvent } from "../../../lib/test-event-actions";
import type { ActionState } from "../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConditionalDestField } from "../destinations/ConditionalDestField";
import { NewDestinationSchemaPolicy } from "../routes/DestinationBindingPicker/SchemaEvolutionPicker";
import {
  FIRST_RUN_DESTINATIONS,
  FIRST_RUN_TLS_NO_VERIFY_DEFAULT,
  firstRunDestination,
  validateDestinationTarget,
  type FirstRunDestinationType,
} from "../../../lib/first-run-destinations";
import { summarizeBackfillProgress } from "../../../lib/first-run-backfill";
import {
  sourceUsesAxelToken,
} from "../../../lib/source-ingest-auth";
import { LocalTime } from "../../_components/LocalTime";
import {
  InboundProviderFields,
  SecretRow,
  SigningSecretHint,
} from "../sources/NewSourcePipelineDialog";
import { TestEventRunner } from "../sources/[id]/TestEventRunner";

/**
 * Full-page, progressive first-run setup (ROL-448 / ROL-457). One step on
 * screen at a time, each unlocking as the previous completes:
 *
 *   1. Create a webhook source — one required field.
 *   2. Point your provider at the endpoint and WAIT for a live event —
 *      the endpoint is the hero, with a live "listening" indicator that
 *      flips to a verified receipt the moment an event lands.
 *   3. Connect a destination — one URL field, inline.
 *
 * This lives on its own route (/setup), NOT behind the dashboard's
 * empty-workspace gate. Creating a source revalidates the sources cache tag,
 * which would flip that gate and unmount the flow mid-setup — taking the
 * one-shot ingest token with it (the bug this file's first version shipped).
 * On /setup the flow holds its position in the tree across revalidation, so
 * client state survives.
 */

interface CreatedSource {
  id: string;
  name: string;
  ingestUrl: string;
  /** Null when recovered from the server after a reload — shown once only. */
  token: string | null;
  signingSecret: string | null;
  provider: SourceProvider;
}

type StepStatus = "locked" | "active" | "done";

/** Successful shape of getFirstRunBackfillStatus (the union's non-error arm). */
type FirstRunBackfillStatus = Exclude<
  Awaited<ReturnType<typeof getFirstRunBackfillStatus>>,
  { error: string }
>;

const BACKFILL_POLL_MS = 1_500;
/** Stop chasing stragglers rather than polling forever on a stuck delivery. */
const MAX_SETTLED_TICKS = 20;

export function FirstRunSetupFlow({
  existingSource,
}: {
  /**
   * Most recent webhook source, when the workspace already has one. Lets a
   * reloaded /setup resume at step 2 with a working endpoint — minus the
   * plaintext token, which is unrecoverable by design.
   */
  existingSource?: {
    id: string;
    name: string;
    ingestUrl: string;
    provider: SourceProvider;
  } | undefined;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createSourceWithPipeline,
    {},
  );
  const [sourceName, setSourceName] = useState("my-first-source");
  const [sourceProvider, setSourceProvider] = useState<SourceProvider>(
    existingSource?.provider ?? "custom",
  );
  // Unmounted (not merely hidden) while collapsed, so a required-but-invisible
  // signing-secret input can never block submit.
  const [showProvider, setShowProvider] = useState(false);
  const [created, setCreated] = useState<CreatedSource | null>(
    existingSource
      ? { ...existingSource, token: null, signingSecret: null }
      : null,
  );
  const [firstEvent, setFirstEvent] = useState<RecentIngestEvent | null>(null);
  const [skippedEventStep, setSkippedEventStep] = useState(false);
  const [pickedType, setPickedType] = useState<FirstRunDestinationType | null>(null);
  const [connected, setConnected] = useState<{
    landing: string;
    backfillJobId?: string;
    backfillEstimated: number;
  } | null>(null);

  useEffect(() => {
    const d = state.data;
    if (pending || !state.notice || !d?.sourceId || !d.ingestUrl) return;
    setCreated(
      (prev) =>
        prev ?? {
          id: d.sourceId!,
          name: sourceName,
          ingestUrl: d.ingestUrl!,
          token: d.plaintextToken ?? null,
          signingSecret: d.webhookSigningSecret ?? null,
          provider: sourceProvider,
        },
    );
  }, [state, pending, sourceName, sourceProvider]);

  const eventSeen = firstEvent !== null;
  const destinationReady = Boolean(created) && (eventSeen || skippedEventStep);
  const step1: StepStatus = created ? "done" : "active";
  const step2: StepStatus = !created ? "locked" : eventSeen ? "done" : "active";
  // Step 3 picks the type, step 4 configures it. Picking is "done" as soon as
  // a type is chosen, so the two read as a pair rather than one long form.
  const step3: StepStatus = !destinationReady
    ? "locked"
    : pickedType
    ? "done"
    : "active";
  const step4: StepStatus = !destinationReady || !pickedType
    ? "locked"
    : connected
    ? "done"
    : "active";

  // No confirm() on the way out. The token panel already carries a standing
  // warning that it's shown once, and a browser dialog on every exit taxes
  // the people who did copy it to catch the few who didn't. If it's lost it
  // can be rotated on the source page.
  function finish() {
    router.push("/dashboard");
  }

  return (
    <ol className="flex flex-col">
      {/* ---------- STEP 1: SOURCE ---------- */}
      <Step
        index={1}
        status={step1}
        title="Create a source"
        blurb={
          created
            ? `Source “${created.name}” is live and ready to receive events.`
            : "A source is the inbound webhook Axel receives events on. One name is all it needs."
        }
      >
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="source_kind" value="webhook" />
          <input type="hidden" name="destination_mode" value="skip" />
          <div className="space-y-1.5">
            <Label htmlFor="fr-source-name">Source name</Label>
            <Input
              id="fr-source-name"
              name="source_name"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              required
              minLength={2}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              A label for where these events come from — your app or provider. Rename any time.
            </p>
          </div>
          {showProvider ? (
            <InboundProviderFields
              value={sourceProvider}
              onValueChange={setSourceProvider}
            />
          ) : (
            // block + self-start: both this and the submit button are
            // inline-block, so without it they collide on one line.
            <button
              type="button"
              onClick={() => setShowProvider(true)}
              className="block text-left text-xs text-muted-foreground underline hover:text-foreground"
            >
              Receiving from Stripe, GitHub, Shopify, or Chargebee? Add signature verification
            </button>
          )}
          {state.error ? (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="pt-1">
            {/* action_intent=skip is the server's authoritative "no destination"
                signal — the same one the modal's "Just create source" sends. */}
            <Button type="submit" name="action_intent" value="skip" disabled={pending}>
              {pending ? "Creating…" : "Create source"}
            </Button>
          </div>
        </form>
      </Step>

      {/* ---------- STEP 2: POINT YOUR WEBHOOK + WAIT ---------- */}
      <Step
        index={2}
        status={step2}
        keepOpen
        title="Point your webhook here"
        blurb={
          eventSeen
            ? "First event received and verified — your endpoint is live."
            : "Copy this URL into your provider's webhook settings. Axel listens and confirms the moment an event arrives."
        }
      >
        {created ? (
          <>
            <EndpointPanel created={created} />
            <FirstEventWatcher
              sourceId={created.id}
              firstEvent={firstEvent}
              onFirstEvent={setFirstEvent}
            />
            {!eventSeen ? (
              <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">
                  Provider not handy? Send a sample event through the real ingest path instead —
                  it proves the endpoint works the same way.
                </p>
                <TestEventRunner
                  sourceId={created.id}
                  onSent={() =>
                    // Fallback completion signal: the live watcher needs
                    // ClickHouse, which isn't guaranteed in every environment.
                    setFirstEvent(
                      (prev) => prev ?? { eventId: "", receivedAt: "", sizeBytes: 0, contentType: "" },
                    )
                  }
                />
                {!skippedEventStep ? (
                  <button
                    type="button"
                    onClick={() => setSkippedEventStep(true)}
                    className="block text-left text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Skip for now — I&apos;ll send an event later
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Step>

      {/* ---------- STEP 3: PICK A DESTINATION TYPE ---------- */}
      <Step
        index={3}
        status={step3}
        title="Where do you want to send these events?"
        blurb={
          pickedType
            ? `${firstRunDestination(pickedType)?.label} selected.`
            : "Axel is storing every event it receives. Pick where they should land and it starts delivering — including the ones already captured, via replay."
        }
      >
        <DestinationPicker onPick={setPickedType} />
        <button
          type="button"
          onClick={finish}
          className="block text-left text-xs text-muted-foreground underline hover:text-foreground"
        >
          Skip for now — finish setup
        </button>
      </Step>

      {/* ---------- STEP 4: CONFIGURE IT ---------- */}
      <Step
        index={4}
        status={step4}
        // keepOpen: without it the step collapses the moment it completes,
        // hiding the backfill result and the only button out of setup.
        keepOpen
        isLast
        title={
          pickedType
            ? `Connect ${firstRunDestination(pickedType)?.label}`
            : "Connect it"
        }
        blurb={
          connected
            ? `Connected — events now deliver to ${connected.landing}.`
            : pickedType
            ? "Just the essentials. Everything else can be tuned later on the destination's page."
            : "Pick a destination above and we'll ask only for what it needs."
        }
      >
        {created && pickedType ? (
          connected ? (
            <BackfillPanel
              jobId={connected.backfillJobId}
              estimated={connected.backfillEstimated}
              onFinish={finish}
            />
          ) : (
            <DestinationForm
              key={pickedType}
              sourceId={created.id}
              type={pickedType}
              onConnected={(result) => setConnected(result)}
              onChangeType={() => setPickedType(null)}
            />
          )
        ) : null}
      </Step>
    </ol>
  );
}

/** Step 3: the menu of places events can go. */
function DestinationPicker({
  onPick,
}: {
  onPick: (type: FirstRunDestinationType) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIRST_RUN_DESTINATIONS.map((dest) => (
          <button
            key={dest.type}
            type="button"
            onClick={() => onPick(dest.type)}
            className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/60 hover:bg-accent/40"
          >
            <span
              className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 font-mono text-[11px] font-semibold text-primary"
              aria-hidden="true"
            >
              {dest.glyph}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{dest.label}</span>
              <span className="block text-xs text-muted-foreground">{dest.blurb}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Need Databricks, R2, or something else?{" "}
        <Link href="/destinations" className="underline hover:text-foreground">
          Set it up on the Destinations page
        </Link>
        .
      </p>
    </>
  );
}

/** The endpoint + one-shot secrets. The hero of step 2. */
function EndpointPanel({ created }: { created: CreatedSource }) {
  const usesAxelToken = sourceUsesAxelToken(created.provider);
  const hasOneShotSecret = Boolean(
    (usesAxelToken && created.token) || created.signingSecret,
  );

  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3">
      {hasOneShotSecret ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-foreground"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600" />
          <span>
            Copy each secret below now. One-shot secrets cannot be retrieved after you leave setup.
          </span>
        </div>
      ) : null}
      <WebhookSetupDetails ingestUrl={created.ingestUrl} provider={created.provider} token={created.token} sourceId={created.id} />
      {created.signingSecret ? (
        <>
          <SecretRow label="Destination signing secret" value={created.signingSecret} />
          <SigningSecretHint />
        </>
      ) : null}
      {usesAxelToken && created.token ? (
        <details className="mt-2 rounded-md border border-border bg-background/50 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">
            Or send one yourself with curl
          </summary>
          <SecretRow
            label="curl"
            value={`curl -X POST "${created.ingestUrl}" \\\n  -H "x-axel-token: ${created.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`}
          />
        </details>
      ) : null}
    </div>
  );
}

const POLL_INTERVAL_MS = 2_500;

function clickhouseToIso(raw: string): string {
  // ClickHouse returns "YYYY-MM-DD HH:MM:SS" in UTC.
  return raw.replace(" ", "T") + "Z";
}

/**
 * Live "waiting for your first event" indicator. Polls the source's ingest
 * history and flips to a verified receipt on the first event. Deliberately
 * loud while waiting — this is the screen a new user sits on with their
 * provider's dashboard open in another tab.
 */
function FirstEventWatcher({
  sourceId,
  firstEvent,
  onFirstEvent,
}: {
  sourceId: string;
  firstEvent: RecentIngestEvent | null;
  onFirstEvent: (event: RecentIngestEvent) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [waitedSec, setWaitedSec] = useState(0);
  const onFirstEventRef = useRef(onFirstEvent);
  useEffect(() => {
    onFirstEventRef.current = onFirstEvent;
  });
  const settled = firstEvent !== null;

  useEffect(() => {
    if (settled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const res = await getRecentIngestEvents(sourceId, 1).catch(
        (): { error: string } => ({
          error: "Couldn't reach the ingest monitor.",
        }),
      );
      if (cancelled) return;
      if ("error" in res) {
        setNote(res.error);
      } else {
        setNote(null);
        const latest = res.events[0];
        if (latest) {
          onFirstEventRef.current(latest);
          return; // stop polling — the step is done
        }
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sourceId, settled]);

  // Elapsed counter, so a long wait doesn't look frozen.
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => setWaitedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [settled]);

  if (settled) {
    return (
      <div
        className="flex items-start gap-2.5 rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3"
        role="status"
      >
        <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-foreground">Event received and verified</p>
          {firstEvent?.eventId ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <Link
                href={`/sources/${sourceId}/events/${firstEvent.eventId}`}
                className="font-mono underline hover:text-foreground"
              >
                {firstEvent.eventId}
              </Link>
              {firstEvent.receivedAt ? (
                <>
                  {" · "}
                  <LocalTime value={clickhouseToIso(firstEvent.receivedAt)} mode="relative" />
                </>
              ) : null}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Axel accepted the event and stored it.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-md border border-border bg-muted/30 p-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Radio className="size-4 animate-pulse text-primary" aria-hidden="true" />
          Waiting for your first event…
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatElapsed(waitedSec)}
        </span>
      </div>
      {/* Indeterminate progress track — this is a wait with no known end, so
          it signals liveness rather than percentage. */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
        <div className="h-full w-1/3 animate-[firstRunScan_1.8s_ease-in-out_infinite] rounded-full bg-primary" />
      </div>
      <style>{`@keyframes firstRunScan{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
      <p className="text-xs leading-5 text-muted-foreground">
        {note ??
          "Trigger any event in your provider — a test webhook from their dashboard works. This page updates on its own; no need to refresh."}
      </p>
    </div>
  );
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Step 4: the shortened per-type form. Field names mirror the full wizard
 * (`dest_field_<key>`, `new_destination_target`) so the server can run the
 * same pre-flight probe and binding builder.
 */
function DestinationForm({
  sourceId,
  type,
  onConnected,
  onChangeType,
}: {
  sourceId: string;
  type: FirstRunDestinationType;
  onConnected: (result: {
    landing: string;
    backfillJobId?: string;
    backfillEstimated: number;
  }) => void;
  onChangeType: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    connectFirstDestination,
    {},
  );
  const spec = firstRunDestination(type)!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  const [targetParts, setTargetParts] = useState<Record<string, string>>({});
  // This escape hatch is deliberately opt-in. Encryption without certificate
  // identity validation is vulnerable to an active man-in-the-middle attack.
  const [tlsNoVerify, setTlsNoVerify] = useState(FIRST_RUN_TLS_NO_VERIFY_DEFAULT);
  const notified = useRef(false);
  const submittedTarget = spec.target?.parts
    ? spec.target.parts
        .map((part) => (targetParts[part.key] ?? "").trim())
        .join(spec.target.separator ?? ".")
    : target;

  useEffect(() => {
    if (pending || !state.notice || !state.data?.destinationId || notified.current) return;
    notified.current = true;
    onConnected({
      landing: submittedTarget.trim() || spec.label,
      ...(state.data.backfillJobId ? { backfillJobId: state.data.backfillJobId } : {}),
      backfillEstimated: state.data.backfillEstimated ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pending]);

  // Catch an unusable table/collection name here rather than after save —
  // the delivery path would dead-letter every event with no visible cause.
  const targetStarted = spec.target?.parts
    ? spec.target.parts.some((part) => (targetParts[part.key] ?? "").trim().length > 0)
    : target.trim().length > 0;
  const targetError =
    spec.target && targetStarted
      ? validateDestinationTarget(type, submittedTarget)
      : null;
  const targetComplete = spec.target?.parts
    ? spec.target.parts.every((part) => (targetParts[part.key] ?? "").trim().length > 0)
    : !spec.target || target.trim().length > 0;
  const complete =
    spec.fields.every((f) => (values[f.key] ?? "").trim().length > 0) &&
    targetComplete &&
    !targetError;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="source_id" value={sourceId} />
      <input type="hidden" name="new_destination_type" value={type} />

      {/* Same schema-driven renderer as the destination create/edit forms and
          the New Source wizard — the "first-run" variant keeps this flow's
          shortened, always-optional-in-HTML presentation while submitting the
          same `dest_field_<key>` names the shared server code reads. */}
      {spec.fields.map((field) => (
        <ConditionalDestField
          key={field.key}
          field={field}
          type={type}
          fieldValues={values}
          setFieldValue={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
          variant="first-run"
          namePrefix="dest_field_"
          idPrefix="fr-dest-"
        />
      ))}

      {spec.tlsToggle ? (
        <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 p-3">
          <input
            type="checkbox"
            name={`dest_field_${spec.tlsToggle.key}`}
            value="true"
            checked={tlsNoVerify}
            onChange={(e) => setTlsNoVerify(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">{spec.tlsToggle.label}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {spec.tlsToggle.hint}
            </span>
          </span>
        </label>
      ) : null}

      {spec.target ? (
        spec.target.parts ? (
          <fieldset className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <legend className="px-1 text-sm font-medium text-foreground">
              {spec.target.label}
            </legend>
            <p className="text-xs text-muted-foreground">{spec.target.hint}</p>
            <input type="hidden" name="new_destination_target" value={submittedTarget} />
            <div className="grid gap-3 sm:grid-cols-2">
              {spec.target.parts.map((part) => {
                const id = `fr-dest-target-${part.key}`;
                return (
                  <div key={part.key} className="space-y-1.5">
                    <Label htmlFor={id}>{part.label}</Label>
                    <Input
                      id={id}
                      name={`new_destination_${part.key}`}
                      value={targetParts[part.key] ?? ""}
                      onChange={(e) =>
                        setTargetParts((current) => ({
                          ...current,
                          [part.key]: e.target.value,
                        }))
                      }
                      placeholder={part.placeholder}
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={targetError ? true : undefined}
                      aria-describedby={targetError ? "fr-dest-target-error" : undefined}
                    />
                    {part.hint ? (
                      <p className="text-xs text-muted-foreground">{part.hint}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {targetError ? (
              <p id="fr-dest-target-error" className="text-xs text-destructive">
                {targetError}
              </p>
            ) : null}
          </fieldset>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="fr-dest-target">{spec.target.label}</Label>
            <Input
              id="fr-dest-target"
              name="new_destination_target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={spec.target.placeholder}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={targetError ? true : undefined}
              aria-describedby={targetError ? "fr-dest-target-error" : undefined}
            />
            {targetError ? (
              <p id="fr-dest-target-error" className="text-xs text-destructive">
                {targetError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{spec.target.hint}</p>
            )}
          </div>
        )
      ) : null}

      {["postgres", "bigquery", "databricks_sql"].includes(type) ? <NewDestinationSchemaPolicy key={type} /> : null}
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" disabled={pending || !complete}>
          {pending ? "Connecting…" : "Connect destination"}
        </Button>
        <Button type="button" variant="ghost" onClick={onChangeType}>
          Choose a different destination
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        We check the connection before saving, so a wrong credential is caught here rather than
        failing on your first event.
      </p>
    </form>
  );
}

/**
 * After connecting, events that arrived before the route existed are replayed
 * into the new destination. This reports that catch-up and then hands the user
 * to the dashboard — the last thing they see in setup, so it has to end on
 * something true: a real count, not a claim we haven't verified.
 */
function BackfillPanel({
  jobId,
  estimated,
  onFinish,
}: {
  jobId?: string;
  estimated: number;
  onFinish: () => void;
}) {
  const [status, setStatus] = useState<FirstRunBackfillStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitedSec, setWaitedSec] = useState(0);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Deliveries drain after the job stops enqueueing, so keep polling briefly
    // past 'done' rather than freezing on a half-finished count.
    let settledTicks = 0;

    const tick = async () => {
      const res = await getFirstRunBackfillStatus(jobId).catch(
        (): { error: string } => ({
          error: "Couldn't read backfill status.",
        }),
      );
      if (cancelled) return;
      if ("error" in res) {
        setNote(res.error);
      } else {
        setNote(null);
        setStatus(res);
        const progress = summarizeBackfillProgress({ ...res, fallbackEstimate: estimated });
        if (progress.finished) return;
        // Settled but still draining: chase stragglers for a bounded while
        // rather than polling forever behind a stuck delivery.
        if (res.settled) {
          if (settledTicks >= MAX_SETTLED_TICKS) return;
          settledTicks += 1;
        }
      }
      timer = setTimeout(() => void tick(), BACKFILL_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `estimated` is a stable prop from the connect response; excluded to keep
    // the poll loop tied to the job alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Elapsed counter, so a wait that's merely slow doesn't read as frozen.
  useEffect(() => {
    if (!jobId) return;
    const id = setInterval(() => setWaitedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [jobId]);

  const progress = status
    ? summarizeBackfillProgress({ ...status, fallbackEstimate: estimated })
    : null;
  // No job at all means there was nothing to catch up on.
  const finished = !jobId || progress?.finished === true;
  const synced = progress?.synced ?? 0;
  const failed = progress?.failed ?? 0;

  return (
    <div className="space-y-4">
      {jobId ? (
        finished ? (
          failed > 0 && synced === 0 ? (
            // Nothing landed. Say so plainly and point at the cause — the
            // alternative is a green tick over a pipeline that delivers nothing.
            <div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">
                  Couldn&apos;t deliver {failed.toLocaleString()} earlier{" "}
                  {failed === 1 ? "event" : "events"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {status?.errorMessage
                    ? `${status.errorMessage}. `
                    : "The destination rejected them. "}
                  Fix the destination, then replay from{" "}
                  <Link href="/deliveries" className="underline hover:text-foreground">
                    Deliveries
                  </Link>
                  . New events will use the same settings, so it&apos;s worth fixing now.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3">
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">
                  Synced {synced.toLocaleString()}{" "}
                  {synced === 1 ? "event" : "events"} received while you were setting up
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {failed > 0
                    ? `${failed.toLocaleString()} couldn't be delivered${status?.errorMessage ? `: ${status.errorMessage}` : ""}. Replay them from Deliveries once the destination is fixed.`
                    : progress?.incomplete
                      ? "The catch-up stopped before finishing. Anything missed can be replayed from the route page."
                      : "Everything Axel had stored for this source has been delivered. New events flow straight through from here."}
                </p>
              </div>
            </div>
          )
        ) : (
          <div
            className="space-y-2.5 rounded-md border border-border bg-muted/30 p-4"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                Sending your earlier events through…
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {synced.toLocaleString()} / {(progress?.total ?? estimated).toLocaleString()} ·{" "}
                {formatElapsed(waitedSec)}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {note ??
                (waitedSec >= 45
                  ? "Still going. This runs on a background worker that checks every minute, so a couple of minutes is normal — you can leave this page and it will carry on."
                  : "Axel stored every event this source received before the destination existed. They're being delivered by a background worker, which can take a minute or two.")}
            </p>
          </div>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          No earlier events to catch up on — new events deliver from here. (Test events aren&apos;t
          backfilled.)
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onFinish}>
          View on dashboard
          <ArrowRight className="ml-1 size-4" />
        </Button>
        <Button variant="outline" asChild>
          <Link href="/routes">View your route</Link>
        </Button>
      </div>
    </div>
  );
}

function Step({
  index,
  status,
  title,
  blurb,
  keepOpen = false,
  isLast = false,
  children,
}: {
  index: number;
  status: StepStatus;
  title: string;
  blurb: string;
  /** Keep content rendered after completion (step 2 keeps its receipt up). */
  keepOpen?: boolean;
  isLast?: boolean;
  children?: React.ReactNode;
}) {
  const open = status === "active" || (keepOpen && status === "done");
  return (
    <li
      className={`relative flex gap-4 ${isLast ? "" : "pb-10"} ${
        status === "locked" ? "opacity-50" : ""
      }`}
      aria-current={status === "active" ? "step" : undefined}
    >
      {!isLast ? (
        <span
          className="absolute left-4 top-10 h-[calc(100%-2.5rem)] w-px -translate-x-1/2 bg-border"
          aria-hidden="true"
        />
      ) : null}
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${
          status === "done"
            ? "bg-emerald-600 text-white"
            : status === "active"
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-muted text-muted-foreground"
        }`}
        aria-hidden="true"
      >
        {status === "done" ? <Check className="size-4" /> : index}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-semibold text-foreground">
          {title}
          <span className="sr-only">
            {status === "done" ? " (complete)" : status === "locked" ? " (locked)" : ""}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{blurb}</p>
        {open && children ? <div className="mt-4 space-y-4">{children}</div> : null}
      </div>
    </li>
  );
}
