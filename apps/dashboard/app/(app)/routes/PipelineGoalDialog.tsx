"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import {
  applyPipelineGoalAction,
  proposePipelineGoalAction,
  type PipelineProposal,
} from "../../../lib/pipeline-proposals";
import { DestinationTargetPicker } from "@/components/destination-target-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const GOAL_EXAMPLE = "invoice.paid, invoice.payment_failed";

/**
 * Plain-language labels for the destination mapping `mode` enum. Keyed by both
 * the route-binding vocabulary (dotted_columns / jsonb_blob) and the mapping
 * vocabulary (columns / jsonb) so whichever value the proposal carries renders
 * a friendly string; unknown values fall back to the raw enum.
 */
const MODE_LABELS: Record<string, string> = {
  dotted_columns: "One column per field (auto-created)",
  jsonb_blob: "Whole event stored as JSON",
  columns: "One column per field (auto-created)",
  jsonb: "Whole event stored as JSON",
  typed_records: "Nested, type-preserving columns",
};

/**
 * Plain-language labels for the webhook `body_strategy` enum. Keyed by both the
 * spec vocabulary and the live mapping values (passthrough / envelope) so the
 * proposal renders friendly copy; unknown values fall back to the raw enum.
 */
const BODY_STRATEGY_LABELS: Record<string, string> = {
  passthrough: "original event body forwarded unchanged",
  forward_raw: "Forward full event payload",
  envelope: "Forward full event payload",
};

/**
 * Plain-language labels for the destination kind. Keyed by `destination.type`
 * (and, as a fallback, the mapping `kind`); unknown values fall back to the raw
 * string.
 */
const MAPPING_KIND_LABELS: Record<string, string> = {
  postgres: "Postgres table",
  mongodb: "MongoDB collection",
  bigquery: "BigQuery table",
  webhook: "Webhook forward",
  http: "HTTP forward",
};

/** Plain-language labels for the backfill-window day count. */
const BACKFILL_LABELS: Record<string, string> = {
  "1": "Last 24 hours",
  "7": "Last 7 days",
  "30": "Last 30 days",
};

function labelFor(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

interface SourceOpt {
  id: string;
  name: string;
}

interface DestinationOpt {
  id: string;
  name: string | null;
  type: string;
}

export function PipelineGoalDialog({
  sources,
  destinations,
  disabledReason,
}: {
  sources: SourceOpt[];
  destinations: DestinationOpt[];
  disabledReason?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [destinationId, setDestinationId] = useState(destinations[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  // Target table/collection — required for container destinations, which
  // store the target as a per-route binding rather than on the destination.
  const [target, setTarget] = useState("");
  const [backfillDays, setBackfillDays] = useState("0");

  const selectedDestType = destinations.find((d) => d.id === destinationId)?.type;
  const needsTarget =
    selectedDestType === "postgres" ||
    selectedDestType === "mongodb" ||
    selectedDestType === "bigquery";
  const [proposal, setProposal] = useState<PipelineProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<"propose" | "apply" | null>(null);
  const [result, setResult] = useState<{
    route_id: string;
    data_contract_id: string;
    version_id: string;
    notice: string;
  } | null>(null);
  const [proposing, startProposing] = useTransition();
  const [applying, startApplying] = useTransition();
  const previewRequestRef = useRef(0);

  const input = useMemo(
    () => ({
      name,
      goal,
      sourceId,
      destinationId,
      target: needsTarget ? target : "",
      backfillDays: Number.parseInt(backfillDays, 10) || 0,
    }),
    [name, goal, sourceId, destinationId, target, needsTarget, backfillDays],
  );
  const previewInput = useMemo(
    () => ({
      goal,
      sourceId,
      destinationId,
      target: needsTarget ? target : "",
    }),
    [goal, sourceId, destinationId, target, needsTarget],
  );
  const readyForPreview = Boolean(
    sourceId && destinationId && (!needsTarget || target.trim()),
  );

  useEffect(() => {
    if (searchParams.get("create") === "1" && !disabledReason) {
      setOpen(true);
    }
  }, [disabledReason, searchParams]);

  function resetProposal() {
    previewRequestRef.current += 1;
    setProposal(null);
    setResult(null);
    setError(null);
    setErrorSource(null);
  }

  function clearCreateParam() {
    if (searchParams.get("create") !== "1") return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("create");
    const suffix = nextParams.toString();
    router.replace(`/routes${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }

  const runPropose = useCallback(() => {
    const requestId = ++previewRequestRef.current;
    setError(null);
    setResult(null);
    setErrorSource(null);
    startProposing(async () => {
      const response = await proposePipelineGoalAction(previewInput);
      if (requestId !== previewRequestRef.current) return;
      if (!response.ok) {
        setProposal(null);
        setErrorSource("propose");
        setError(mapProposalError(response.error));
        return;
      }
      setProposal(response.proposal);
    });
  }, [previewInput]);

  useEffect(() => {
    if (!open || result || !readyForPreview) return;
    const timer = window.setTimeout(runPropose, 400);
    return () => window.clearTimeout(timer);
  }, [open, readyForPreview, result, runPropose]);

  function runApply() {
    setError(null);
    setResult(null);
    setErrorSource(null);
    startApplying(async () => {
      const response = await applyPipelineGoalAction(input);
      if (!response.ok) {
        if (response.proposal) setProposal(response.proposal);
        setErrorSource("apply");
        setError(mapProposalError(response.error));
        return;
      }
      setResult(response);
    });
  }

  // Explains why creation is disabled while the automatic preview is being
  // prepared or its validation gate is closed.
  const approveDisabledReason = !readyForPreview
    ? "Pick a source, destination, and target first."
    : proposing
      ? "Preparing and validating the mapping preview."
      : !proposal
        ? "The mapping preview must be ready before creating the pipeline."
        : !name.trim()
          ? "Name your pipeline first."
          : !proposal.validation.can_activate
            ? "Fix the blocking issues in the preview before creating."
            : undefined;

  // Resolve the selected source/destination to display names for the success
  // card, falling back to the id when a name is missing or the row is gone.
  const createdSourceLabel = sources.find((s) => s.id === sourceId)?.name ?? sourceId;
  const createdDestinationLabel = (() => {
    const dest = destinations.find((d) => d.id === destinationId);
    if (!dest) return destinationId;
    return dest.name ?? dest.id;
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          previewRequestRef.current += 1;
          setProposal(null);
          setResult(null);
          setError(null);
          setErrorSource(null);
          setName("");
          clearCreateParam();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={Boolean(disabledReason)} title={disabledReason}>
          <Sparkles className="size-4" />
          Make Pipeline
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>
            Pick a source and a destination. Axel reads recent events, infers the field mapping, and
            shows you a preview before anything goes live. Add an optional filter to forward only
            certain event types.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <section className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pipeline-name">Pipeline name</Label>
              <Input
                id="pipeline-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="chargebee-prod-to-mongo"
                minLength={2}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                className="h-9"
              />
            </div>
            {/* Source → destination is the pipeline. These come first; the
                filter/transform instruction below is optional. */}
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pipeline-source">Source</Label>
                <Select
                  value={sourceId}
                  onValueChange={(value) => {
                    setSourceId(value);
                    resetProposal();
                  }}
                >
                  <SelectTrigger id="pipeline-source" className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pipeline-destination">Destination</Label>
                <Select
                  value={destinationId}
                  onValueChange={(value) => {
                    setDestinationId(value);
                    setTarget("");
                    resetProposal();
                  }}
                >
                  <SelectTrigger id="pipeline-destination" className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((destination) => (
                      <SelectItem key={destination.id} value={destination.id}>
                        {destination.name ?? destination.id} ({destination.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {needsTarget && destinationId ? (
              <DestinationTargetPicker
                key={destinationId}
                destinationId={destinationId}
                destinationType={selectedDestType!}
                value={target}
                onChange={(next) => {
                  setTarget(next);
                  resetProposal();
                }}
              />
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="pipeline-goal">Filter / transform (optional)</Label>
              <Textarea
                id="pipeline-goal"
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  resetProposal();
                }}
                rows={4}
                maxLength={2000}
                placeholder={GOAL_EXAMPLE}
                aria-describedby="pipeline-goal-help"
              />
              <div className="flex items-start justify-between gap-2">
                <p id="pipeline-goal-help" className="text-xs text-muted-foreground">
                  Optional. Name the event types to forward (e.g.{" "}
                  <code className="font-mono">invoice.paid</code>). Leave blank to forward every event
                  type — Axel infers the field mapping from your destination either way.{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    onClick={() => {
                      setGoal(GOAL_EXAMPLE);
                      resetProposal();
                    }}
                  >
                    Use example
                  </button>
                </p>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {goal.length}/2000
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              {/* Progressive disclosure: backfill is opt-in and stays collapsed by
                  default. The selected window (and the queued-backfill warning) are
                  surfaced even while collapsed so the consequence is never hidden. */}
              <details className="group rounded-md border border-border">
                <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm text-foreground [&::-webkit-details-marker]:hidden">
                  <span className="font-medium">Backfill (optional)</span>
                  {Number.parseInt(backfillDays, 10) > 0 ? (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      {labelFor(BACKFILL_LABELS, backfillDays)}
                    </span>
                  ) : null}
                </summary>
                <div className="space-y-1.5 border-t border-border px-3 py-3">
                  <Label htmlFor="pipeline-backfill">Backfill window</Label>
                  <Select
                    value={backfillDays}
                    onValueChange={setBackfillDays}
                  >
                    <SelectTrigger id="pipeline-backfill" className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Do not backfill</SelectItem>
                      <SelectItem value="1">Last 24 hours</SelectItem>
                      <SelectItem value="7">Last 7 days</SelectItem>
                      <SelectItem value="30">Last 30 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Re-delivers events Axel received in this window. Each replayed event is a fresh delivery —
                    running a backfill twice queues duplicates.
                  </p>
                </div>
              </details>
              {Number.parseInt(backfillDays, 10) > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Creating the pipeline will immediately queue a backfill for this window.
                </p>
              ) : null}
            </div>

            {error ? (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertTitle>
                  {errorSource === "apply" ? "Pipeline creation failed" : "Couldn't prepare preview"}
                </AlertTitle>
                <AlertDescription>
                  <p>{error}</p>
                  {error.includes("No recent events") && sourceId ? (
                    <p className="mt-1">
                      <Link
                        href={`/sources/${sourceId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        find the ingest URL and send a test event, then return here
                      </Link>
                    </p>
                  ) : null}
                  {errorSource === "apply" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={
                        proposing ||
                        applying ||
                        !proposal ||
                        !proposal.validation.can_activate
                      }
                      onClick={runApply}
                    >
                      {applying ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                      Retry creation
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={proposing || applying || !sourceId || !destinationId || (needsTarget && !target.trim())}
                      onClick={runPropose}
                    >
                      {proposing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                      Retry preview
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            ) : null}

            {result ? (
              <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                  Pipeline created.
                </div>
                <p className="text-sm text-muted-foreground">
                  Events from{" "}
                  <span className="font-medium text-foreground">{createdSourceLabel}</span> now flow to{" "}
                  <span className="font-medium text-foreground">{createdDestinationLabel}</span>.
                </p>
                {Number.parseInt(backfillDays, 10) > 0 ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    A backfill for the selected window has been queued.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <Link href={`/routes/${result.route_id}`}>View route</Link>
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    Close
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Span wrapper so the tooltip still fires while the button is disabled. */}
                      <span className="inline-flex">
                        <Button
                          type="button"
                          disabled={
                            !proposal ||
                            applying ||
                            proposing ||
                            !name.trim() ||
                            !proposal.validation.can_activate
                          }
                          title={approveDisabledReason}
                          onClick={runApply}
                        >
                          {applying ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                          {applying ? "Creating pipeline…" : "Create pipeline"}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {approveDisabledReason ? (
                      <TooltipContent>{approveDisabledReason}</TooltipContent>
                    ) : null}
                  </Tooltip>
                </TooltipProvider>
              </div>
              {proposal && !proposal.validation.can_activate ? (
                <p className="text-xs text-destructive">
                  Fix the blocking issues in the preview before creating.
                </p>
              ) : null}
            </div>
          </section>

          <section className="min-w-0">
            {proposal ? (
              <ProposalReview proposal={proposal} />
            ) : (
              <div className="flex min-h-[420px] flex-col justify-center rounded-lg border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
                {readyForPreview && !error ? (
                  <div className="flex items-center justify-center gap-2 text-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Preparing and validating your mapping preview…
                  </div>
                ) : error ? (
                  <div className="text-center">
                    <p className="mb-2 font-medium text-foreground">Preview unavailable</p>
                    <p>Resolve the issue shown beside the form, then retry the preview.</p>
                  </div>
                ) : (
                  <>
                    <p className="mb-2 font-medium text-foreground">Choose where events should flow</p>
                    <p>
                      Select a source, destination, and target. Axel will automatically sample recent
                      events and show the exact mapping here before you create the pipeline.
                    </p>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Maps known server error strings to friendlier, actionable copy. */
function mapProposalError(error: string): string {
  if (error.includes("unsupported-type") || error.includes("does not support destination type")) {
    return "This destination type isn't supported yet. Pick a Postgres, MongoDB, BigQuery, or HTTP destination.";
  }
  return error;
}

function ProposalReview({ proposal }: { proposal: PipelineProposal }) {
  const fixture = proposal.validation.fixture_result;

  // Deterministic, non-LLM summary line derived straight from the proposal so
  // the user gets a stable at-a-glance recap regardless of the model's prose.
  const sourceLabel = proposal.source.name;
  const destinationLabel = proposal.destination.name ?? proposal.destination.id;
  const mappingTarget =
    proposal.mapping.kind === "postgres"
      ? proposal.mapping.table
      : proposal.mapping.kind === "mongodb"
        ? proposal.mapping.collection
        : proposal.mapping.kind === "bigquery"
          ? `${proposal.mapping.dataset}.${proposal.mapping.table}`
        : labelFor(MAPPING_KIND_LABELS, proposal.destination.type ?? proposal.mapping.kind);
  const eventTypeCount = proposal.selected_event_type_names.length;
  const fieldCount = proposal.data_contract.field_count;
  const deterministicSummary = `${sourceLabel} → ${destinationLabel} (${mappingTarget}) · ${eventTypeCount} event type${
    eventTypeCount === 1 ? "" : "s"
  } · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{proposal.source.name}</Badge>
          <span className="text-xs text-muted-foreground">to</span>
          <Badge variant="secondary">
            {proposal.destination.name ?? proposal.destination.id} ({proposal.destination.type})
          </Badge>
          <Badge variant={proposal.validation.can_activate ? "default" : "destructive"} className="ml-auto">
            {proposal.validation.can_activate ? "ready" : "blocked"}
          </Badge>
        </div>
        <p className="mb-1 text-sm font-medium text-foreground">{deterministicSummary}</p>
        <p className="text-sm text-muted-foreground">{proposal.data_contract.summary}</p>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <Metric label="Samples" value={String(proposal.data_contract.sample_count)} />
          <Metric label="Fields" value={String(proposal.data_contract.field_count)} />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Metric label="Fixtures" value={`${fixture.passed}/${fixture.total}`} />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Axel ran {fixture.total} test events through this pipeline configuration — {fixture.passed} passed
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Panel title="Event Scope">
          <div className="flex flex-wrap gap-1.5">
            {proposal.data_contract.event_types.length === 0 ? (
              <span className="text-xs text-muted-foreground">No event types inferred.</span>
            ) : (
              proposal.data_contract.event_types.map((eventType) => (
                <Badge key={eventType.name} variant={eventType.selected ? "default" : "secondary"}>
                  {eventType.name} · {eventType.sample_count}
                </Badge>
              ))
            )}
          </div>
        </Panel>
        <Panel title="Destination Mapping">
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">
                {labelFor(MAPPING_KIND_LABELS, proposal.destination.type ?? proposal.mapping.kind)}
              </span>{" "}
              {"rationale" in proposal.mapping ? proposal.mapping.rationale : ""}
            </div>
            {proposal.mapping.kind === "postgres" ? (
              <div>
                table <code className="font-mono text-foreground">{proposal.mapping.table}</code>, mode{" "}
                <span className="text-foreground">{labelFor(MODE_LABELS, proposal.mapping.mode)}</span>
              </div>
            ) : null}
            {proposal.mapping.kind === "mongodb" ? (
              <div>
                collection <code className="font-mono text-foreground">{proposal.mapping.collection}</code>
              </div>
            ) : null}
            {proposal.mapping.kind === "bigquery" ? (
              <div>
                table{" "}
                <code className="font-mono text-foreground">
                  {proposal.mapping.dataset}.{proposal.mapping.table}
                </code>
                , mode{" "}
                <span className="text-foreground">
                  {labelFor(MODE_LABELS, proposal.mapping.mode)}
                </span>
              </div>
            ) : null}
            {proposal.mapping.kind === "webhook" ? (
              <>
                <div>
                  body <span className="text-foreground">{labelFor(BODY_STRATEGY_LABELS, proposal.mapping.body_strategy)}</span>
                </div>
                {proposal.destination.type === "http" ? (
                  <div>Unsigned POST</div>
                ) : (
                  <div>Signed with HMAC-SHA256 — verify the X-Axel-Signature header</div>
                )}
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      {proposal.validation.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-foreground">
            <TriangleAlert className="size-3.5" />
            Review before creating
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {proposal.validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Panel title="Compiled Declarations">
        <p className="mb-2 text-xs text-muted-foreground">
          The exact filter and transform Axel will run for every matching event.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <CodeBlock label="Filter" value={proposal.filter} />
          <CodeBlock label="Transform" value={proposal.transform} />
        </div>
      </Panel>

      <Panel title="Sample Preview">
        <div className="space-y-2">
          {proposal.preview.length === 0 ? (
            <span className="text-xs text-muted-foreground">No preview rows available.</span>
          ) : (
            proposal.preview.map((row) => (
              <div key={row.event_id} className="space-y-1">
                <code className="font-mono text-[10px] text-muted-foreground">{row.event_id}</code>
                <div className="grid gap-2 md:grid-cols-2">
                  <Pre label="Before" value={row.before} />
                  <Pre label="After" value={row.after} />
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-muted/40 p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="max-h-44 overflow-auto font-mono text-[10px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
