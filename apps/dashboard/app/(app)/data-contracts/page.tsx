import Link from "next/link";
import { ArrowRight, Map as MapIcon } from "lucide-react";
import { requireSession } from "../../../lib/session";
import { listDataContractsForWorkspace } from "../../../lib/data-contracts/repository";
import { LocalTime } from "../../_components/LocalTime";
import { EntityStatusBadge } from "../../_components/StatusBadges";

export const dynamic = "force-dynamic";

export default async function DataContractsListPage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const maps = await listDataContractsForWorkspace(workspaceId);

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Data Contracts
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One Data Contract per source. A map captures every event type the source
            emits — flip between them on the detail page to read each contract on
            its own. Pick a source and run
            <span className="rounded-sm bg-muted px-1 font-mono text-xs"> Understand source </span>
            to create one.
          </p>
        </div>
      </div>

      {maps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <MapIcon className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <h2 className="mt-3 text-lg font-medium text-foreground">No Data Contracts yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Open a source detail page and click{" "}
            <strong className="text-foreground">Understand source</strong> to sample its recent
            events and propose a draft Data Contract.
          </p>
          <Link
            href="/sources"
            className="mt-4 inline-flex items-center gap-1 text-sm text-foreground hover:underline"
          >
            Go to Sources
            <ArrowRight className="size-3" />
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {maps.map((m) => (
            <li key={m.id}>
              <Link
                href={`/data-contracts/${m.id}`}
                prefetch={false}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {m.name}
                    </span>
                    <EntityStatusBadge status={m.status} />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    source {m.source_id}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  <LocalTime value={m.updated_at} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
