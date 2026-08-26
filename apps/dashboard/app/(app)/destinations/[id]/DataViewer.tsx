import Link from "next/link";
import { ArrowLeft, RotateCw } from "lucide-react";
import { inspectDestination, type InspectResult } from "../../../../lib/destination-inspect";
import type { DestinationType } from "../../../../lib/destination-defaults";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Server-rendered data viewer panel. Streams in via the parent page's
 * Suspense boundary so the page header / edit form paints immediately.
 *
 * Unsupported types (http, webhook, r2, s3) render explanatory text rather
 * than trying to "view" something that's write-only or object-storage-only.
 */
export async function DataViewer({
  destinationId,
  workspaceId,
  type,
  table,
  schema,
  collection,
}: {
  destinationId: string;
  workspaceId: string;
  type: DestinationType;
  table?: string;
  schema?: string;
  collection?: string;
}) {
  if (type === "http") {
    return (
      <p className="text-sm text-muted-foreground">
        HTTP destinations are write-only — Axel POSTs events to your endpoint
        but doesn&apos;t fetch anything back. There&apos;s nothing to browse here. Use
        the{" "}
        <Link
          href={`/destinations/${destinationId}#delivery-history`}
          className="text-foreground underline"
        >
          delivery history
        </Link>{" "}
        below to see what got POSTed.
      </p>
    );
  }
  if (type === "webhook") {
    return (
      <p className="text-sm text-muted-foreground">
        Signed webhooks are write-only — Axel POSTs HMAC-signed events to your
        endpoint but never reads back. Receivers verify the{" "}
        <code className="rounded-sm bg-muted px-1 font-mono text-xs">X-Axel-Signature</code>{" "}
        header against the signing secret you captured on creation. Use the{" "}
        <Link
          href={`/destinations/${destinationId}#delivery-history`}
          className="text-foreground underline"
        >
          delivery history
        </Link>{" "}
        below to inspect what got POSTed (request body, signature header, response code).
      </p>
    );
  }
  if (type === "s3" || type === "r2") {
    return (
      <p className="text-sm text-muted-foreground">
        Object-storage destinations are list-only — every event lands as one
        object under the configured prefix. A native S3 / R2 object browser is
        on the roadmap; for now use the AWS or Cloudflare console.
      </p>
    );
  }
  if (type === "databricks_volume") {
    return (
      <p className="text-sm text-muted-foreground">
        Databricks Volume destinations write JSON files into a Unity Catalog
        Volume — point Auto Loader at the volume to stream them into Delta. A
        native volume browser is on the roadmap; for now use the Databricks
        Catalog Explorer or <code className="rounded-sm bg-muted px-1 font-mono text-xs">LIST</code>{" "}
        in a SQL editor.
      </p>
    );
  }

  const result: InspectResult = await inspectDestination(destinationId, workspaceId, {
    ...(table !== undefined ? { table } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(collection !== undefined ? { collection } : {}),
  });

  if (result.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <div className="space-y-2">
            <strong className="font-semibold">Couldn&apos;t connect to the destination.</strong>
            <code className="block break-all rounded-sm bg-muted px-2 py-1 font-mono text-[11px]">
              {result.message}
            </code>
            <p className="text-xs">
              Common causes: connection string expired, credentials rotated upstream, IP allow-list
              not including Vercel egress, TLS-required but cert rejected. The credentials column on
              this page shows the fingerprint you currently have stored.
            </p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  if (result.kind === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground">
        Data viewer doesn&apos;t support {result.type} yet.
      </p>
    );
  }

  if (result.kind === "tables") {
    if (result.tables.length === 0) {
      return <p className="text-sm text-muted-foreground">No user tables found in this database.</p>;
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {result.tables.length} table{result.tables.length === 1 ? "" : "s"} visible to this connection.
          Pick one to preview the most-recent rows.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {result.tables.map((t) => {
            const includeSchema = type === "bigquery" || t.schema !== "public";
            const href = `/destinations/${destinationId}/data?table=${encodeURIComponent(t.name)}${includeSchema ? `&schema=${encodeURIComponent(t.schema)}` : ""}`;
            return (
              <Link
                key={`${t.schema}.${t.name}`}
                href={href}
                className="flex flex-col gap-0.5 rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-muted/50"
              >
                <strong className="font-medium text-foreground">{t.name}</strong>
                <small className="text-xs text-muted-foreground">{t.schema}</small>
              </Link>
            );
          })}
        </div>
      </div>
    );
  }

  if (result.kind === "collections") {
    if (result.collections.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">No collections in {result.database}.</p>
      );
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {result.collections.length} collection{result.collections.length === 1 ? "" : "s"} in{" "}
          <code className="rounded-sm bg-muted px-1 font-mono text-xs">{result.database}</code>.
          Pick one to preview newest documents.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {result.collections.map((c) => (
            <Link
              key={c}
              href={`/destinations/${destinationId}/data?collection=${encodeURIComponent(c)}`}
              className="flex flex-col gap-0.5 rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-muted/50"
            >
              <strong className="font-medium text-foreground">{c}</strong>
              <small className="text-xs text-muted-foreground">{result.database}</small>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  if (result.kind === "rows") {
    // Build a refresh URL that preserves the table/schema params but adds a
    // ts= cache-buster so the RSC re-renders rather than serving cached HTML.
    const refreshParams = new URLSearchParams();
    if (table) refreshParams.set("table", table);
    if (schema && (type === "bigquery" || schema !== "public")) refreshParams.set("schema", schema);
    refreshParams.set("ts", String(Date.now()));
    const refreshHref = `/destinations/${destinationId}/data?${refreshParams.toString()}`;
    // Postgres rows come back ordered newest-first via the hidden `ctid`
    // column. Databricks Delta has no analogous physical-ordering primitive
    // exposed via SQL, so we just LIMIT and don't claim an ordering.
    const orderingNote = type === "postgres"
      ? " Ordered newest-first by physical insertion (`ctid`)."
      : "";
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <small className="text-xs text-muted-foreground">
            Showing {result.total_visible} row{result.total_visible === 1 ? "" : "s"}
            {result.truncated ? ", limited to 100 by Axel." : "."}
            {result.total_estimate !== null
              ? ` Table has ~${result.total_estimate.toLocaleString()} rows total (estimate).`
              : ""}
            {orderingNote}
          </small>
          <span className="flex items-center gap-3 text-xs">
            <Link
              href={refreshHref}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="size-3" />
              refresh
            </Link>
            <Link
              href={`/destinations/${destinationId}/data`}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3" />
              back to tables
            </Link>
          </span>
        </div>
        <RowsTable columns={result.columns} rows={result.rows} />
      </div>
    );
  }

  // documents (mongo)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <small className="text-xs text-muted-foreground">
          Showing {result.total_visible} document{result.total_visible === 1 ? "" : "s"}
          {result.total_count !== null
            ? ` of ${result.total_count.toLocaleString()} total in collection`
            : ""}
          {result.truncated ? ", limited to 100." : "."} Ordered newest-first by `_id`.
        </small>
        <Link
          href={`/destinations/${destinationId}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          back to collections
        </Link>
      </div>
      <DocumentsView documents={result.documents} />
    </div>
  );
}

function RowsTable({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Table is empty.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c}>
                  <CellValue value={row[c]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DocumentsView({ documents }: { documents: Array<Record<string, unknown>> }) {
  if (documents.length === 0) {
    return <p className="text-sm text-muted-foreground">Collection is empty.</p>;
  }
  return (
    <div className="space-y-2">
      {documents.map((doc, i) => (
        <details key={i} className="rounded-md border border-border bg-muted/30 p-2">
          <summary className="flex cursor-pointer items-center gap-2 text-sm">
            <code className="font-mono text-xs">{String(doc._id ?? `[${i}]`)}</code>
            <small className="text-xs text-muted-foreground">
              {Object.keys(doc).length} fields
            </small>
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
            {safeJson(doc)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <small className="text-muted-foreground">NULL</small>;
  }
  if (typeof value === "object") {
    return <code className="font-mono text-[11px]">{safeJson(value).slice(0, 120)}</code>;
  }
  if (typeof value === "boolean") {
    return <code className="font-mono">{String(value)}</code>;
  }
  if (value instanceof Date) {
    return <small>{value.toISOString()}</small>;
  }
  const str = String(value);
  if (str.length > 120) return <span title={str}>{str.slice(0, 120)}…</span>;
  return <span>{str}</span>;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      // Mongo's BSON types serialize to objects with toJSON; let JSON.stringify handle them.
      return v;
    }, 2);
  } catch {
    return String(value);
  }
}
