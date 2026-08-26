import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireSession } from "../../../../../lib/session";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { DataViewer } from "../DataViewer";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";

export default async function DestinationDataPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ table?: string; schema?: string; collection?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  const destination = await getDestinationSummary(id, workspaceId);
  if (!destination) notFound();

  const isTableType = destination.type === "postgres" || destination.type === "mongodb" || destination.type === "databricks_sql" || destination.type === "bigquery";

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Data viewer</h2>
        {isTableType ? <Badge variant="outline">read-only · 100-row cap · 8s timeout</Badge> : null}
      </div>
      <div className="space-y-3 p-5">
        <Suspense fallback={<Skeleton className="h-60 w-full" />}>
          <DataViewer
            destinationId={destination.id}
            workspaceId={workspaceId}
            type={destination.type}
            {...(sp.table !== undefined ? { table: sp.table } : {})}
            {...(sp.schema !== undefined ? { schema: sp.schema } : {})}
            {...(sp.collection !== undefined ? { collection: sp.collection } : {})}
          />
        </Suspense>
      </div>
    </section>
  );
}
