"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, BellOff, CheckCircle2, Database, Keyboard, Loader2, RotateCw, Sparkles, VolumeX, Wrench } from "lucide-react";
import {
  applyFingerprintRepair,
  applyFingerprintSchemaRepair,
  muteFingerprint,
  previewFingerprintRepair,
  retryFingerprint,
  unmuteFingerprint,
  type RepairPreviewResult,
  type ActionState,
} from "../../../lib/inbox-actions";
import type { InboxRepairSpec } from "../../../lib/inbox-repair";
import type { InboxGroup } from "../../../lib/inbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { ConfirmAction } from "../../_components/ConfirmAction";
import { LocalTime } from "../../_components/LocalTime";
import { dataTypeRepairFor } from "../../../lib/dead-letter-repair";

/** Plain-English labels for Jev's typed dead-letter reasons. */
const TRIAGE_LABELS: Record<string, string> = {
  transient: "Transient",
  destination_down: "Destination down",
  schema_mismatch: "Schema mismatch",
  bad_payload: "Bad payload",
  auth_or_config: "Auth or config",
};

/**
 * Linear-style inbox UI for dead letter groups (AXE-57).
 *
 * Each row is fully clickable + ships visible Retry / Mute / Investigate
 * buttons so the page works equally well with mouse and keyboard.
 *
 * Mouse:
 *   - Click anywhere on the row body → opens the exemplar dead letter
 *     in /deliveries/[id]/investigate.
 *   - Click Retry → enqueues a bulk replay for the fingerprint.
 *   - Click Mute → silences the fingerprint for 24h.
 *   - Click Unmute (on a muted row) → restores it.
 *
 * Keyboard:
 *   - j / ↓        next group
 *   - k / ↑        previous group
 *   - Enter        open exemplar
 *   - r            retry focused fingerprint
 *   - m            mute focused fingerprint for 24h
 *   - u            unmute (muted row)
 *   - ?            toggle the hint bar
 */

interface Props {
  groups: InboxGroup[];
  mutedCount: number;
  showMuted: boolean;
  /**
   * Archive mode — every group has `count = 0` and at least one
   * recently-resolved letter. Hides the Retry button (nothing to
   * retry) and changes the icon/styling so the operator can tell
   * the row's been handled.
   */
  showResolved: boolean;
}

export function InboxClient({ groups, showResolved }: Props) {
  const router = useRouter();
  const [focused, setFocused] = useState(0);
  const [showHints, setShowHints] = useState(false);
  const [muteState, muteAction] = useActionState<ActionState, FormData>(muteFingerprint, {});
  const [unmuteState, unmuteAction] = useActionState<ActionState, FormData>(unmuteFingerprint, {});
  const [retryState, retryAction] = useActionState<ActionState, FormData>(retryFingerprint, {});
  const [repairGroup, setRepairGroup] = useState<InboxGroup | null>(null);
  const [repairPreview, setRepairPreview] = useState<RepairPreviewResult | null>(null);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairStrategy, setRepairStrategy] = useState<"destination" | "transform">("destination");
  const [rounding, setRounding] = useState<"round" | "floor" | "ceil" | "truncate">("round");
  const [arrayFormat, setArrayFormat] = useState<"json" | "join">("json");
  const [separator, setSeparator] = useState(", ");
  const [previewPending, startPreview] = useTransition();
  const [applyPending, startApply] = useTransition();

  const muteFormRef = useRef<HTMLFormElement>(null);
  const unmuteFormRef = useRef<HTMLFormElement>(null);
  const retryFormRef = useRef<HTMLFormElement>(null);
  const repairFingerprintRef = useRef<string | null>(null);

  function openRepair(group: InboxGroup) {
    repairFingerprintRef.current = group.fingerprint;
    setRepairGroup(group);
    setRepairPreview(null);
    setRepairError(null);
    setRepairStrategy("destination");
    setRounding("round");
    setArrayFormat("json");
    setSeparator(", ");
    startPreview(async () => {
      const result = await previewFingerprintRepair({
        fingerprint: group.fingerprint,
        exemplarId: group.exemplar_id,
      });
      // Ignore an old response if the operator opened another fingerprint.
      if (repairFingerprintRef.current === group.fingerprint) setRepairPreview(result);
    });
  }

  function applyRepair() {
    if (!repairGroup || !repairPreview?.ok) return;
    const proposed = repairPreview.proposal.repair;
    const repair: InboxRepairSpec = proposed.kind === "coerce" && proposed.to === "integer"
      ? { ...proposed, rounding }
      : proposed.kind === "collapse_array"
        ? {
            ...proposed,
            format: arrayFormat,
            ...(arrayFormat === "join" ? { separator } : {}),
          }
        : proposed;
    setRepairError(null);
    startApply(async () => {
      const useDestinationSchema = repairStrategy === "destination" && repairPreview.schemaRepair;
      const result = useDestinationSchema
        ? await applyFingerprintSchemaRepair({
            fingerprint: repairGroup.fingerprint,
            exemplarId: repairGroup.exemplar_id,
          })
        : await applyFingerprintRepair({
            fingerprint: repairGroup.fingerprint,
            exemplarId: repairGroup.exemplar_id,
            repair,
          });
      if (!result.ok) {
        setRepairError(result.error);
        return;
      }
      setRepairNotice(result.notice);
      repairFingerprintRef.current = null;
      setRepairGroup(null);
      setRepairPreview(null);
      router.refresh();
    });
  }

  // Refresh the list after every action so the row that just got
  // muted/retried disappears (or reappears under "Show muted") on the
  // next paint.
  useEffect(() => {
    if (muteState.notice || unmuteState.notice || retryState.notice) {
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muteState.notice, unmuteState.notice, retryState.notice]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack keys when the user is typing into an input.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((f) => Math.min(groups.length - 1, f + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((f) => Math.max(0, f - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const g = groups[focused];
        if (g) router.push(`/deliveries/${g.exemplar_id}/investigate`);
      } else if (e.key === "r") {
        e.preventDefault();
        const g = groups[focused];
        const repair = g
          ? dataTypeRepairFor({
              reason: g.reason,
              message: g.message_excerpt,
              routeId: g.route_id,
              destinationId: g.destination_id,
            })
          : null;
        if (repair) openRepair(g!);
        else retryFormRef.current?.requestSubmit();
      } else if (e.key === "m") {
        e.preventDefault();
        muteFormRef.current?.requestSubmit();
      } else if (e.key === "u") {
        e.preventDefault();
        unmuteFormRef.current?.requestSubmit();
      } else if (e.key === "?") {
        e.preventDefault();
        setShowHints((s) => !s);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, focused, router]);

  const focusedGroup = groups[focused];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2 text-xs text-muted-foreground">
        <span>
          {groups.length} fingerprint{groups.length === 1 ? "" : "s"} ·{" "}
          {showResolved
            ? `${groups.reduce((acc, g) => acc + g.resolved_24h, 0)} resolved in last 24h`
            : `${groups.reduce((acc, g) => acc + g.count, 0)} total dead letter${groups.reduce((acc, g) => acc + g.count, 0) === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={() => setShowHints((s) => !s)}
          className="flex items-center gap-1 hover:text-foreground"
          aria-label="Toggle keyboard shortcuts"
        >
          <Keyboard className="size-3" /> ?
        </button>
      </div>

      {showHints ? (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <strong className="text-foreground">Keys:</strong>{" "}
          <kbd className="rounded border border-border bg-card px-1.5">j</kbd> / <kbd className="rounded border border-border bg-card px-1.5">k</kbd> navigate ·{" "}
          <kbd className="rounded border border-border bg-card px-1.5">Enter</kbd> open ·{" "}
          <kbd className="rounded border border-border bg-card px-1.5">r</kbd> retry / open fix ·{" "}
          <kbd className="rounded border border-border bg-card px-1.5">m</kbd> mute 24h ·{" "}
          <kbd className="rounded border border-border bg-card px-1.5">u</kbd> unmute
        </div>
      ) : null}

      {muteState.error ? <Alert variant="destructive"><AlertDescription>{muteState.error}</AlertDescription></Alert> : null}
      {muteState.notice ? <Alert><AlertDescription>{muteState.notice}</AlertDescription></Alert> : null}
      {retryState.error ? <Alert variant="destructive"><AlertDescription>{retryState.error}</AlertDescription></Alert> : null}
      {retryState.notice ? <Alert><AlertDescription>{retryState.notice}</AlertDescription></Alert> : null}
      {unmuteState.error ? <Alert variant="destructive"><AlertDescription>{unmuteState.error}</AlertDescription></Alert> : null}
      {unmuteState.notice ? <Alert><AlertDescription>{unmuteState.notice}</AlertDescription></Alert> : null}
      {repairError && !repairGroup ? <Alert variant="destructive"><AlertDescription>{repairError}</AlertDescription></Alert> : null}
      {repairNotice ? <Alert><AlertDescription>{repairNotice}</AlertDescription></Alert> : null}

      <ol className="overflow-hidden rounded-lg border border-border bg-card">
        {groups.map((g, idx) => (
          <InboxRow
            key={g.fingerprint}
            group={g}
            focused={idx === focused}
            onFocus={() => setFocused(idx)}
            muteAction={muteAction}
            retryAction={retryAction}
            unmuteAction={unmuteAction}
            onRepair={() => openRepair(g)}
            isArchive={showResolved}
          />
        ))}
      </ol>

      {/* Hidden forms target the focused fingerprint. Submitted via
          requestSubmit() from the keyboard handler. */}
      {focusedGroup ? (
        <>
          <form ref={muteFormRef} action={muteAction} className="hidden">
            <input type="hidden" name="fingerprint" value={focusedGroup.fingerprint} />
            <input type="hidden" name="hours" value="24" />
          </form>
          <form ref={unmuteFormRef} action={unmuteAction} className="hidden">
            <input type="hidden" name="fingerprint" value={focusedGroup.fingerprint} />
          </form>
          <form ref={retryFormRef} action={retryAction} className="hidden">
            <input type="hidden" name="fingerprint" value={focusedGroup.fingerprint} />
          </form>
        </>
      ) : null}

      <RepairDialog
        group={repairGroup}
        preview={repairPreview}
        previewPending={previewPending}
        applyPending={applyPending}
        error={repairError}
        strategy={repairStrategy}
        onStrategyChange={setRepairStrategy}
        rounding={rounding}
        onRoundingChange={setRounding}
        arrayFormat={arrayFormat}
        onArrayFormatChange={setArrayFormat}
        separator={separator}
        onSeparatorChange={setSeparator}
        onApply={applyRepair}
        onOpenChange={(open) => {
          if (!open && !applyPending) {
            repairFingerprintRef.current = null;
            setRepairGroup(null);
            setRepairPreview(null);
            setRepairError(null);
          }
        }}
      />
    </div>
  );
}

function InboxRow({
  group,
  focused,
  onFocus,
  muteAction,
  retryAction,
  unmuteAction,
  onRepair,
  isArchive,
}: {
  group: InboxGroup;
  focused: boolean;
  onFocus: () => void;
  muteAction: (formData: FormData) => void;
  retryAction: (formData: FormData) => void;
  unmuteAction: (formData: FormData) => void;
  onRepair: () => void;
  isArchive: boolean;
}) {
  const router = useRouter();
  const isMuted = group.muted_until !== null;
  const investigateHref = `/deliveries/${group.exemplar_id}/investigate`;
  const repair = dataTypeRepairFor({
    reason: group.reason,
    message: group.message_excerpt,
    routeId: group.route_id,
    destinationId: group.destination_id,
  });

  // Click on the row body opens the exemplar. The action buttons stop
  // propagation so they don't trigger the navigation.
  function onRowClick(e: React.MouseEvent) {
    if (e.defaultPrevented) return;
    onFocus();
    router.push(investigateHref);
  }

  return (
    <li
      onClick={onRowClick}
      onMouseEnter={onFocus}
      className={`grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 ${focused ? "bg-muted/40" : "hover:bg-muted/20"}`}
    >
      <div className="pt-0.5">
        {isArchive ? (
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : isMuted ? (
          <BellOff className="size-4 text-muted-foreground" />
        ) : (
          <AlertTriangle className="size-4 text-destructive" />
        )}
      </div>

      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge
            variant={isArchive ? "secondary" : isMuted ? "secondary" : "destructive"}
            className="capitalize"
          >
            {group.reason}
          </Badge>
          {isArchive ? (
            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              ✓ {group.resolved_24h} resolved
            </span>
          ) : (
            <span className="text-sm font-semibold text-foreground">×{group.count}</span>
          )}
          {!isArchive && group.resolved_24h > 0 ? (
            <span
              className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400"
              title="Letters in this fingerprint resolved in the last 24h — your retries are landing"
            >
              {group.resolved_24h} resolved 24h
            </span>
          ) : null}
          {group.triage_reason ? (
            <Badge
              variant="outline"
              title={
                group.triage_confidence !== null
                  ? `Jev triage, confidence ${Math.round(group.triage_confidence * 100)}%`
                  : "Jev triage"
              }
            >
              {TRIAGE_LABELS[group.triage_reason] ?? group.triage_reason}
            </Badge>
          ) : null}
          {!isArchive && group.auto_replayed > 0 ? (
            <span
              className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400"
              title="Axel judged these transient and queued a replay without waiting for you"
            >
              {group.auto_replayed} auto-replayed
            </span>
          ) : null}
          {group.source_id ? (
            <small className="font-mono text-[11px] text-muted-foreground">
              src={group.source_id}
            </small>
          ) : null}
          {group.route_id ? (
            <small className="font-mono text-[11px] text-muted-foreground">
              route={group.route_id}
            </small>
          ) : null}
        </div>
        <p className="break-words text-xs text-muted-foreground">
          {group.message_excerpt || "(no message)"}
        </p>
        {!isArchive && repair ? (
          <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs">
            <p className="font-medium text-foreground">{repair.title}</p>
            <p className="mt-0.5 text-muted-foreground">{repair.detail}</p>
          </div>
        ) : null}
        {isMuted ? (
          <p className="text-[11px] italic text-muted-foreground">
            Muted{group.muted_reason ? ` · ${group.muted_reason}` : ""} · until{" "}
            <LocalTime value={group.muted_until!} />
          </p>
        ) : null}
      </div>

      <div className="text-right text-[11px] text-muted-foreground">
        {isArchive && group.last_resolved_at ? (
          <div>
            resolved <LocalTime value={group.last_resolved_at} />
          </div>
        ) : (
          <>
            <div>
              first <LocalTime value={group.first_seen} />
            </div>
            <div>
              last <LocalTime value={group.last_seen} />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {isArchive ? null : isMuted ? (
          <RowAction
            action={unmuteAction}
            fingerprint={group.fingerprint}
            label="Unmute"
            icon={<BellOff className="size-3.5" />}
            confirmText={null}
          />
        ) : (
          <>
            {repair ? (
              <button
                type="button"
                onClick={onRepair}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 text-xs font-medium text-foreground hover:bg-amber-500/20"
              >
                <Wrench className="size-3.5" />
                {repair.actionLabel}
              </button>
            ) : (
              <RowAction
                action={retryAction}
                fingerprint={group.fingerprint}
                label="Retry"
                icon={<RotateCw className="size-3.5" />}
                confirmText={
                  group.count > 10
                    ? `Replay all ${group.count} dead letters in this group?`
                    : null
                }
              />
            )}
            <RowAction
              action={muteAction}
              fingerprint={group.fingerprint}
              label="Mute 24h"
              icon={<VolumeX className="size-3.5" />}
              confirmText={null}
              hidden={{ name: "hours", value: "24" }}
            />
          </>
        )}
        <Link
          href={investigateHref}
          prefetch={false}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
        >
          <Sparkles className="size-3" />
          Investigate
        </Link>
      </div>
    </li>
  );
}

function RepairDialog({
  group,
  preview,
  previewPending,
  applyPending,
  error,
  strategy,
  onStrategyChange,
  rounding,
  onRoundingChange,
  arrayFormat,
  onArrayFormatChange,
  separator,
  onSeparatorChange,
  onApply,
  onOpenChange,
}: {
  group: InboxGroup | null;
  preview: RepairPreviewResult | null;
  previewPending: boolean;
  applyPending: boolean;
  error: string | null;
  strategy: "destination" | "transform";
  onStrategyChange: (value: "destination" | "transform") => void;
  rounding: "round" | "floor" | "ceil" | "truncate";
  onRoundingChange: (value: "round" | "floor" | "ceil" | "truncate") => void;
  arrayFormat: "json" | "join";
  onArrayFormatChange: (value: "json" | "join") => void;
  separator: string;
  onSeparatorChange: (value: string) => void;
  onApply: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const proposal = preview?.ok ? preview.proposal : null;
  const repair = proposal?.repair;
  const schemaRepair = preview?.ok ? preview.schemaRepair : undefined;
  const useDestinationSchema = Boolean(schemaRepair && strategy === "destination");
  return (
    <Dialog open={group !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {schemaRepair ? (
              <Database className="size-4 text-amber-600" />
            ) : (
              <Wrench className="size-4 text-amber-600" />
            )}
            {proposal?.title ?? "Prepare an automatic fix"}
          </DialogTitle>
          <DialogDescription>
            {schemaRepair
              ? "Choose whether to preserve the incoming decimals in BigQuery or convert them before delivery."
              : "Axel will add this conversion only on the path to the affected destination. Other route outputs stay unchanged."}
          </DialogDescription>
        </DialogHeader>

        {previewPending || (!preview && group) ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Finding the exact field and checking the destination schema…
          </div>
        ) : preview && !preview.ok ? (
          <Alert variant="destructive"><AlertDescription>{preview.error}</AlertDescription></Alert>
        ) : proposal && repair ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p>{proposal.summary}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Field</dt>
                <dd><code className="rounded bg-background px-1.5 py-0.5">{proposal.issue.path}</code></dd>
                <dt className="text-muted-foreground">Incoming</dt>
                <dd>{proposal.issue.expected}</dd>
                <dt className="text-muted-foreground">Target column</dt>
                <dd>{proposal.issue.existing}</dd>
              </dl>
            </div>

            {schemaRepair ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">How should Axel resolve it?</legend>
                <label
                  className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                    strategy === "destination"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="repair-strategy"
                    value="destination"
                    checked={strategy === "destination"}
                    onChange={() => onStrategyChange("destination")}
                    className="mt-1"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Database className="size-4" />
                      Preserve decimals
                      <Badge variant="secondary" className="text-[10px]">Recommended</Badge>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {schemaRepair.status === "needed"
                        ? <>Change <code>{schemaRepair.dataset}.{schemaRepair.table}</code> field <code>{schemaRepair.fieldPath}</code> from INT64 to FLOAT64, then replay. Event values stay unchanged.</>
                        : <>The destination field already uses FLOAT64. Replay without changing route data.</>}
                    </span>
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                    strategy === "transform"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="repair-strategy"
                    value="transform"
                    checked={strategy === "transform"}
                    onChange={() => onStrategyChange("transform")}
                    className="mt-1"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="block text-sm font-medium">Keep the destination as INT64</span>
                    <span className="block text-xs text-muted-foreground">
                      Convert values in this route before delivery. Fractional precision will be permanently removed.
                    </span>
                  </span>
                </label>
              </fieldset>
            ) : null}

            {repair.kind === "coerce" && repair.to === "integer" && !useDestinationSchema ? (
              <div className="space-y-2">
                <Label htmlFor="repair-rounding">How should decimals become integers?</Label>
                <Select value={rounding} onValueChange={(value) => onRoundingChange(value as typeof rounding)}>
                  <SelectTrigger id="repair-rounding" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round" description="5.69 becomes 6; 5.2 becomes 5.">Nearest integer (recommended)</SelectItem>
                    <SelectItem value="floor" description="Always round down: 5.69 becomes 5.">Round down</SelectItem>
                    <SelectItem value="ceil" description="Always round up: 5.01 becomes 6.">Round up</SelectItem>
                    <SelectItem value="truncate" description="Drop the fractional part: -5.69 becomes -5.">Drop decimals</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {repair.kind === "collapse_array" ? (
              <div className="space-y-2">
                <Label htmlFor="repair-array-format">How should the array be stored?</Label>
                <Select value={arrayFormat} onValueChange={(value) => onArrayFormatChange(value as typeof arrayFormat)}>
                  <SelectTrigger id="repair-array-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json" description='Preserves the full array, for example ["vip","wholesale"].'>JSON text (recommended)</SelectItem>
                    <SelectItem value="join" description='Creates one readable value, for example "vip, wholesale".'>Join values</SelectItem>
                  </SelectContent>
                </Select>
                {arrayFormat === "join" ? (
                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="repair-separator">Separator</Label>
                    <Input
                      id="repair-separator"
                      value={separator}
                      maxLength={32}
                      onChange={(event) => onSeparatorChange(event.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {useDestinationSchema
                ? <>Confirming {schemaRepair?.status === "needed" ? "updates the BigQuery schema and " : ""}immediately replays {group?.count ?? 0} failed {group?.count === 1 ? "delivery" : "deliveries"}. The destination service account must be allowed to run jobs and update the table. The change is recorded in the audit log.</>
                : <>Confirming updates the route and immediately replays {group?.count ?? 0} failed {group?.count === 1 ? "delivery" : "deliveries"}. The change is recorded in the audit log.</>}
            </p>
          </div>
        ) : null}

        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={applyPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!proposal || applyPending || previewPending} onClick={onApply}>
            {applyPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : useDestinationSchema ? (
              <Database className="size-4" />
            ) : (
              <Wrench className="size-4" />
            )}
            {applyPending
              ? useDestinationSchema ? "Updating BigQuery…" : "Applying fix…"
              : useDestinationSchema
                ? schemaRepair?.status === "needed"
                  ? `Change type & replay ${group?.count ?? 0}`
                  : `Replay ${group?.count ?? 0}`
                : `Apply conversion & replay ${group?.count ?? 0}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowAction({
  action,
  fingerprint,
  label,
  icon,
  confirmText,
  hidden,
}: {
  action: (formData: FormData) => void;
  fingerprint: string;
  label: string;
  icon: React.ReactNode;
  confirmText: string | null;
  hidden?: { name: string; value: string };
}) {
  const button = (
    <Button
      type={confirmText ? "button" : "submit"}
      variant="outline"
      size="sm"
      className="h-7 gap-1 text-xs"
    >
      {icon}
      {label}
    </Button>
  );
  return (
    <form action={action} onClick={(e) => e.stopPropagation()}>
      <input type="hidden" name="fingerprint" value={fingerprint} />
      {hidden ? <input type="hidden" name={hidden.name} value={hidden.value} /> : null}
      {confirmText ? (
        <ConfirmAction title={label} body={confirmText} confirmLabel={label}>
          {button}
        </ConfirmAction>
      ) : (
        button
      )}
    </form>
  );
}
