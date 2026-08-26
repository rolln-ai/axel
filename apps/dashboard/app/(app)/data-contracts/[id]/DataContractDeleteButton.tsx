"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { deleteDataContractAction } from "../../../../lib/data-contracts/actions";
import { ConfirmAction } from "../../../_components/ConfirmAction";
import { useAction } from "../../../_components/useAction";

/**
 * Destructive Delete control for the Data Contract detail page header.
 * Confirmation goes through the shared `ConfirmAction` dialog (this used to
 * be a bespoke inline arm/confirm pair); any error renders below as an
 * Alert (right-aligned).
 */
export function DataContractDeleteButton({
  dataContractId,
  dataContractName,
}: {
  dataContractId: string;
  dataContractName: string;
}) {
  const router = useRouter();
  const del = useAction(deleteDataContractAction, {
    onSuccess: () => {
      router.push("/data-contracts");
      router.refresh();
    },
  });

  return (
    <div className="relative">
      <ConfirmAction
        title="Delete Data Contract"
        body={`Delete "${dataContractName}"? This permanently removes the schema, all versions, fixtures, and drift history. Routes that referenced it stay running.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => del.run(dataContractId)}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={del.pending}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="mr-1 size-3.5" />
          {del.pending ? "Deleting…" : "Delete"}
        </Button>
      </ConfirmAction>
      {del.error ? (
        <div className="absolute right-0 top-full mt-1 z-10">
          <Alert variant="destructive" className="max-w-sm py-2 text-xs">
            <AlertDescription>{del.error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
