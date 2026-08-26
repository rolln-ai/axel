"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Map as MapIcon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EntityStatusBadge } from "../../../_components/StatusBadges";
import {
  understandSourceAction,
  type DataContractsActionState,
} from "../../../../lib/data-contracts/actions";

interface DataContractSummary {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  updated_at: string;
}

export function DataContractsSection({
  sourceId,
  sourceName,
  dataContracts,
  canMutate,
}: {
  sourceId: string;
  sourceName: string;
  dataContracts: DataContractSummary[];
  canMutate: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<DataContractsActionState, FormData>(
    understandSourceAction,
    {},
  );

  useEffect(() => {
    if (state.data?.dataContractId) {
      router.push(`/data-contracts/${state.data.dataContractId}`);
    } else if (state.notice && !state.error) {
      router.refresh();
    }
  }, [state.data?.dataContractId, state.notice, state.error, router]);

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        An Data Contract is the durable contract describing what this source emits and how to route
        it. Click <strong className="text-foreground">Understand source</strong> to sample recent
        events and propose a draft.
      </p>

      {canMutate ? (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="source_id" value={sourceId} />
          <input type="hidden" name="source_name" value={sourceName} />
          <Button type="submit" disabled={pending}>
            <Sparkles className="mr-1 size-4" />
            {pending ? "Sampling + inferring…" : "Understand source"}
          </Button>
          {state.error ? (
            <Alert variant="destructive" className="ml-2 py-2 text-xs">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only owners and admins can create Data Contracts.
        </p>
      )}

      {dataContracts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          <MapIcon className="mx-auto mb-1 size-5" aria-hidden />
          No Data Contracts yet for this source.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {dataContracts.map((m) => (
            <li key={m.id}>
              <Link
                href={`/data-contracts/${m.id}`}
                className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50"
              >
                <span className="truncate text-sm text-foreground">{m.name}</span>
                <EntityStatusBadge status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
