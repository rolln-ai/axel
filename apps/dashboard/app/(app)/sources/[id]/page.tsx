import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { LocalTime } from "../../../_components/LocalTime";
import { Section } from "../../../_components/Section";
import { SourceOverview } from "./SourceOverview";
import { EntityStatusBadge } from "../../../_components/StatusBadges";
import { DriftPanel } from "./DriftPanel";
import { DataContractsSection } from "./DataContractsSection";
import {
  FieldSelectionChecklist,
  type ContractField,
} from "./FieldSelectionChecklist";
import { FieldSelectionEditor } from "./FieldSelectionEditor";
import { IpAllowlistEditor } from "./IpAllowlistEditor";
import { SubjectKeysEditor } from "./SubjectKeysEditor";
import { LimitsEditor } from "./LimitsEditor";
import {
  resolveIngestBaseUrl,
  sanitizeConnectorDiagnosticForStorage,
  type SourceProvider,
  type SubjectKeyPath,
} from "@axel/shared";
import { TransientModeEditor } from "./TransientModeEditor";
import { PullSourceSyncPanel } from "./PullSourceSyncPanel";
import { SendTestEventDialog } from "./SendTestEventDialog";
import { SourceTokenPanel } from "./SourceTokenPanel";
import { db } from "../../../../lib/db";
import {
  findActiveDataContractForSource,
  listDataContractsForSource,
  listUnresolvedDriftForSource,
} from "../../../../lib/data-contracts/repository";
import { requireSession } from "../../../../lib/session";
import {
  formatCount,
  listSourceEvents,
  usageEnabled,
  type SourceEventRow,
} from "../../../../lib/usage";
import { fetchPayloadForR2Key, GENERIC_SAMPLE } from "../../../../lib/sample-payload";
import { deploymentCapabilities } from "../../../../lib/deployment-capabilities";
import {
  sourceAuthenticationCopy,
  sourceAuthHeaderExample,
} from "../../../../lib/source-ingest-auth";
import type { FieldSpec, InferredDataContract } from "../../../../lib/data-contracts/inference";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

interface SourceRow {
  id: string;
  name: string;
  status: "active" | "disabled";
  // Includes the retired pull-source connector kinds — legacy rows with
  // postgres/mongodb/bigquery kinds still exist in the DB and keep syncing.
  source_kind: "webhook" | "chargebee" | "stripe" | "shopify" | "postgres" | "mongodb" | "bigquery";
  pull_config: Record<string, unknown> | null;
  max_events_per_minute: number | null;
  max_body_bytes: number | null;
  max_body_depth: number | null;
  created_at: string;
  routes_attached: number;
  field_selection: string[] | null;
  // AXE-23 — provider preset + signing-secret fingerprint for the
  // "signature verification" badge on the source detail page.
  provider: SourceProvider;
  signing_secret_fingerprint: string | null;
  url_token_enabled: boolean;
  // AXE-34 — inbound IP allowlist (CIDRs); empty = accept any IP.
  inbound_ip_allowlist: string[];
  // GDPR — configured subject-key paths for per-subject erasure indexing.
  subject_key_paths: SubjectKeyPath[] | null;
  // AXE-35 — transient mode + per-source retention override.
  transient_mode: boolean;
  raw_payload_retention_days: number | null;
  workspace_raw_payload_retention_days: number;
}

interface PullSyncRunRow {
  id: string;
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  records_emitted: number;
  error_message: string | null;
}

type SourceTabKey = "overview" | "contract" | "ingest" | "sync" | "settings";

const TAB_KEYS: SourceTabKey[] = ["overview", "contract", "ingest", "sync", "settings"];

function resolveActiveTab(raw: string | string[] | undefined): SourceTabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && (TAB_KEYS as string[]).includes(value)) return value as SourceTabKey;
  return "overview";
}

export default async function SourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const activeTab = resolveActiveTab(sp.tab);

  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const timezone = session.activeWorkspace.workspace_timezone;
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  // Source + drift queries are both keyed by the URL id and workspaceId, so
  // run them in parallel rather than waterfalling. notFound() still wins —
  // worst case we waste a tiny drift query on an unknown id.
  const [sourceResult, driftRows] = await Promise.all([
    db().query<SourceRow>(
      `SELECT sources.id,
              sources.name,
              sources.status,
              COALESCE(ps.type, 'webhook') AS source_kind,
              ps.config AS pull_config,
              sources.max_events_per_minute,
              sources.max_body_bytes,
              sources.max_body_depth,
              sources.created_at::text,
              sources.field_selection,
              COALESCE(sources.provider, 'custom') AS provider,
              sources.signing_secret_fingerprint,
              (sources.url_token_hash IS NOT NULL) AS url_token_enabled,
              sources.inbound_ip_allowlist,
              sources.subject_key_paths,
              sources.transient_mode,
              sources.raw_payload_retention_days,
              (SELECT raw_payload_retention_days FROM workspaces w WHERE w.id = sources.workspace_id) AS workspace_raw_payload_retention_days,
              (SELECT count(*)::int FROM routes r
                WHERE r.source_id = sources.id AND r.status = 'active') AS routes_attached
         FROM sources
         LEFT JOIN pull_sources ps ON ps.id = sources.id AND ps.workspace_id = sources.workspace_id
        WHERE sources.id = $1 AND sources.workspace_id = $2
        LIMIT 1`,
      [id, workspaceId],
    ),
    activeTab === "contract" ? listUnresolvedDriftForSource(workspaceId, id) : Promise.resolve([]),
  ]);
  const source = sourceResult.rows[0];
  if (!source) notFound();

  // Drop the user back to overview if they hit a tab that doesn't
  // apply to this source kind (ingest=webhook only, sync=pull only).
  let resolvedTab = activeTab;
  const isWebhook = source.source_kind === "webhook";
  if (activeTab === "ingest" && !isWebhook) resolvedTab = "overview";
  if (activeTab === "sync" && isWebhook) resolvedTab = "overview";

  const ingestUrl = `${resolveIngestBaseUrl(process.env)}/in/${source.id}`;


  return (
    <>
      <SourceHeader
        source={source}
        ingestUrl={ingestUrl}
        canMutate={canMutate}
      />


      {resolvedTab === "overview" ? (
        <SourceOverview
          source={source}
          workspaceId={workspaceId}
          timezone={timezone}
        />
      ) : resolvedTab === "contract" ? (
        <ContractTab
          source={source}
          workspaceId={workspaceId}
          canMutate={canMutate}
          driftRows={driftRows}
        />
      ) : resolvedTab === "ingest" ? (
        <IngestTab
          source={source}
          ingestUrl={ingestUrl}
          canMutate={canMutate}
        />
      ) : resolvedTab === "sync" ? (
        <SyncTab
          source={source}
          workspaceId={workspaceId}
          canMutate={canMutate}
        />
      ) : (
        <SettingsTab
          source={source}
          ingestUrl={ingestUrl}
          canMutate={canMutate}
          isWebhook={isWebhook}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Header (shared across all tabs)
// ---------------------------------------------------------------------------

function SourceHeader({
  source,
  ingestUrl,
  canMutate,
}: {
  source: SourceRow;
  ingestUrl: string;
  canMutate: boolean;
}) {
  const isWebhook = source.source_kind === "webhook";
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
      <div className="flex flex-col gap-1">
        <Link
          href="/sources"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          All sources
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {source.name}
        </h1>
        <small className="font-mono text-xs text-muted-foreground">{source.id}</small>
      </div>
      <div className="flex items-center gap-2">
        <EntityStatusBadge status={source.status} className="capitalize">
          {source.source_kind} · {source.status}
        </EntityStatusBadge>
        {isWebhook ? (
          <SendTestEventDialog
            sourceId={source.id}
            sourceName={source.name}
            ingestUrl={ingestUrl}
            canMutate={canMutate}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contract tab — Data Contracts + Drift + Field selection (contract-driven)
// ---------------------------------------------------------------------------

async function ContractTab({
  source,
  workspaceId,
  canMutate,
  driftRows,
}: {
  source: SourceRow;
  workspaceId: string;
  canMutate: boolean;
  driftRows: Awaited<ReturnType<typeof listUnresolvedDriftForSource>>;
}) {
  const [dataContractsForSource, activeMap, recentEvents] = await Promise.all([
    listDataContractsForSource(workspaceId, source.id),
    findActiveDataContractForSource(workspaceId, source.id),
    usageEnabled()
      ? listSourceEvents(workspaceId, source.id, 1).catch(() => [] as SourceEventRow[])
      : Promise.resolve([] as SourceEventRow[]),
  ]);

  const samplePayloadPromise: Promise<unknown> = recentEvents.length > 0
    ? fetchPayloadForR2Key(recentEvents[0]!.r2_key, {
        workspaceId,
        eventId: recentEvents[0]!.event_id,
        sourceId: source.id,
      })
        .then((p) => p ?? GENERIC_SAMPLE)
        .catch(() => GENERIC_SAMPLE)
    : Promise.resolve(GENERIC_SAMPLE);

  const contractFields = activeMap
    ? flattenContractFields(activeMap.version.inferred_schema as InferredDataContract)
    : [];

  return (
    <>
      <Section title="Data Contracts" pill="AI-native event contracts" className="first:mt-0">
        <DataContractsSection
          sourceId={source.id}
          sourceName={source.name}
          canMutate={canMutate}
          dataContracts={dataContractsForSource.map((m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            updated_at: m.updated_at,
          }))}
        />
      </Section>

      <Section
        title="Drift"
        pill={driftRows.length === 0 ? "no unresolved drift" : `${driftRows.length} unresolved`}
        className="first:mt-0"
      >
        <DriftPanel
          sourceId={source.id}
          canResolve={canMutate}
          drifts={driftRows.map((d) => ({
            id: d.id,
            data_contract_id: d.data_contract_id,
            data_contract_name: d.data_contract_name,
            category: d.category,
            field_path: d.field_path,
            observed_at: d.observed_at,
          }))}
        />
      </Section>

      <Section title="Field selection" pill="applies on next ingest" className="first:mt-0">
        <p className="text-sm text-muted-foreground">
          By default, every field of the incoming payload is forwarded. Pick specific fields to
          {" "}<strong className="text-foreground">project</strong>{" "}the payload — only the named
          fields reach the destination. The raw payload is still kept in R2 for audit / replay.
        </p>
        {contractFields.length > 0 ? (
          <Suspense fallback={<FieldSelectionSkeleton />}>
            <FieldSelectionChecklistLoader
              sourceId={source.id}
              initialPaths={source.field_selection}
              contractFields={contractFields}
              samplePayloadPromise={samplePayloadPromise}
            />
          </Suspense>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              No active Data Contract for this source yet — run{" "}
              <strong className="text-foreground">Understand source</strong> above to get a checklist
              of fields drawn from the contract. Until then you can still configure paths manually:
            </div>
            <Suspense fallback={<FieldSelectionSkeleton />}>
              <LegacyFieldSelectionLoader
                sourceId={source.id}
                initialPaths={source.field_selection}
                samplePayloadPromise={samplePayloadPromise}
              />
            </Suspense>
          </div>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Ingest tab — webhook URL + cURL example (only for webhook sources)
// ---------------------------------------------------------------------------

function IngestTab({
  source,
  ingestUrl,
  canMutate,
}: {
  source: SourceRow;
  ingestUrl: string;
  canMutate: boolean;
}) {
  const authHeader = sourceAuthHeaderExample(source.provider);

  return (
    <Section title="Ingest endpoint" pill="production" className="first:mt-0">
      <p className="text-sm text-muted-foreground">
        {sourceAuthenticationCopy(source.provider)} The body is stored and forwarded{" "}
        <strong className="text-foreground">verbatim</strong> — Axel doesn&apos;t require any
        particular JSON shape, top-level field, or even{" "}
        <code className="rounded-sm bg-muted px-1 font-mono text-xs">application/json</code>{" "}
        content-type.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
{`POST ${ingestUrl}
  ${authHeader}
  content-type: application/json   # any content-type accepted

  <any body up to the configured max size>`}
      </pre>
      <p className="text-xs text-muted-foreground">
        Examples: a Stripe <code className="font-mono">payment_intent.succeeded</code> webhook, a
        GitHub <code className="font-mono">push</code> event, a custom internal event, a CSV row
        wrapped as JSON — all flow through unchanged.
      </p>
      <Link href={`/sources/${source.id}?tab=settings`} className="inline-block text-sm underline hover:text-foreground">
        Manage header tokens and authenticated webhook URLs
      </Link>
      <div className="mt-3">
        <SendTestEventDialog
          sourceId={source.id}
          sourceName={source.name}
          ingestUrl={ingestUrl}
          canMutate={canMutate}
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sync tab — pull worker runs (only for pull sources)
// ---------------------------------------------------------------------------

async function SyncTab({
  source,
  workspaceId,
  canMutate,
}: {
  source: SourceRow;
  workspaceId: string;
  canMutate: boolean;
}) {
  const pullRunsRes = await db().query<PullSyncRunRow>(
    `SELECT id,
            status,
            started_at::text,
            finished_at::text,
            records_emitted,
            error_message
       FROM pull_sync_runs
      WHERE pull_source_id = $1 AND workspace_id = $2
      ORDER BY started_at DESC
      LIMIT 5`,
    [source.id, workspaceId],
  );
  const pullRuns = pullRunsRes.rows;

  return (
    <Section title="Sync source" pill={source.source_kind} className="first:mt-0">
      <p className="text-sm text-muted-foreground">
        Pull worker syncs this source and emits each record into the same route pipeline used by
        webhooks. Routes attached to this source can deliver synced records to any destination.
      </p>
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <SyncMeta label="Streams" value={formatStreams(source.pull_config)} />
        <SyncMeta label="Last run" value={pullRuns[0] ? pullRuns[0].status : "none yet"} />
        <SyncMeta
          label="Last records"
          value={pullRuns[0] ? formatCount(pullRuns[0].records_emitted) : "0"}
        />
      </div>
      <PullSourceSyncPanel sourceId={source.id} canSync={canMutate && source.status === "active"} />
      {pullRuns.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pullRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-xs">{run.id}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        run.status === "success"
                          ? "default"
                          : run.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {run.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <LocalTime value={run.started_at} />
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {formatCount(run.records_emitted)}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                    {run.error_message
                      ? sanitizeConnectorDiagnosticForStorage(run.error_message, 400)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <small className="block text-xs text-muted-foreground">
        Created <LocalTime value={source.created_at} />
      </small>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Settings tab — token, limits, IPs, transient mode
// ---------------------------------------------------------------------------

function SettingsTab({
  source,
  ingestUrl,
  canMutate,
  isWebhook,
}: {
  source: SourceRow;
  ingestUrl: string;
  canMutate: boolean;
  isWebhook: boolean;
}) {
  return (
    <Section title="Configuration" className="first:mt-0">
      {isWebhook ? (
        <SourceTokenPanel
          key={source.id}
          sourceId={source.id}
          urlTokenEnabled={source.url_token_enabled}
          ingestUrl={ingestUrl}
          canRotate={canMutate}
          provider={source.provider}
          signingSecretFingerprint={source.signing_secret_fingerprint}
        />
      ) : null}
      <div className={isWebhook ? "border-t border-border pt-5" : ""}>
        <LimitsEditor
          sourceId={source.id}
          initialMaxEventsPerMinute={source.max_events_per_minute}
          initialMaxBodyBytes={source.max_body_bytes}
          initialMaxBodyDepth={source.max_body_depth}
        />
      </div>
      {isWebhook ? (
        <div className="border-t border-border pt-5">
          <IpAllowlistEditor
            sourceId={source.id}
            initialAllowlist={source.inbound_ip_allowlist ?? []}
            canMutate={canMutate}
          />
        </div>
      ) : null}
      <div className="border-t border-border pt-5">
        <SubjectKeysEditor
          sourceId={source.id}
          initialKeys={source.subject_key_paths ?? []}
          canMutate={canMutate}
        />
      </div>
      <div className="border-t border-border pt-5">
        <TransientModeEditor
          sourceId={source.id}
          initialTransientMode={source.transient_mode}
          initialRetentionOverride={source.raw_payload_retention_days}
          workspaceDefaultDays={source.workspace_raw_payload_retention_days}
          canMutate={canMutate}
          capabilityAvailable={deploymentCapabilities().configurableRawPayloadRetention}
        />
      </div>
      <small className="block text-xs text-muted-foreground">
        Created <LocalTime value={source.created_at} />
      </small>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenContractFields(schema: InferredDataContract): ContractField[] {
  const sensitive = new Set((schema.sensitive_fields ?? []).map((s) => s.path));
  const entries = Object.entries(schema.fields ?? {});
  return entries
    .map<ContractField>(([path, spec]: [string, FieldSpec]) => ({
      path,
      category: spec.category ?? "string",
      presence: spec.presence,
      sensitive: sensitive.has(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function SyncMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-medium text-foreground">{value}</p>
    </div>
  );
}

function formatStreams(config: Record<string, unknown> | null): string {
  const streams = config && Array.isArray(config.streams) ? config.streams : [];
  const selected = streams
    .map((stream) => stream && typeof stream === "object" && "name" in stream ? stream.name : null)
    .filter((name): name is string => typeof name === "string");
  return selected.length > 0 ? selected.join(", ") : "all";
}

async function FieldSelectionChecklistLoader({
  sourceId,
  initialPaths,
  contractFields,
  samplePayloadPromise,
}: {
  sourceId: string;
  initialPaths: string[] | null;
  contractFields: ContractField[];
  samplePayloadPromise: Promise<unknown>;
}) {
  const samplePayload = await samplePayloadPromise;
  return (
    <FieldSelectionChecklist
      sourceId={sourceId}
      initialPaths={initialPaths}
      contractFields={contractFields}
      samplePayload={samplePayload}
    />
  );
}

async function LegacyFieldSelectionLoader({
  sourceId,
  initialPaths,
  samplePayloadPromise,
}: {
  sourceId: string;
  initialPaths: string[] | null;
  samplePayloadPromise: Promise<unknown>;
}) {
  const samplePayload = await samplePayloadPromise;
  return (
    <FieldSelectionEditor
      sourceId={sourceId}
      initialPaths={initialPaths}
      samplePayload={samplePayload}
    />
  );
}

function FieldSelectionSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Skeleton className="h-56" />
      <Skeleton className="h-56" />
    </div>
  );
}
