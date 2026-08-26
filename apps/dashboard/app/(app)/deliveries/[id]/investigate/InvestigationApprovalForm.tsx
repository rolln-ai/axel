"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { approvePatchAction } from "../../../../../lib/data-contracts/actions";
import { useAction } from "../../../../_components/useAction";
import type {
  DataContractVersionRow,
} from "../../../../../lib/data-contracts/repository";
import type { ProposedPatch } from "../../../../../lib/data-contracts/explain";
import type { SampledEvent } from "../../../../../lib/data-contracts/sampler";

/**
 * Approval row at the bottom of an investigation page. Calls
 * approvePatchAction which:
 *
 *   1. Appends a NEW data_contract_versions row with the patched transform.
 *   2. Regenerates fixtures from fresh samples and inserts them.
 *   3. Runs the activation gate (FixturesFailedError aborts here — no
 *      version, no fixtures, no replay get committed).
 *   4. Queues one replay_requests row scoped to the failed delivery.
 *
 * All four steps are inside one Postgres transaction. The button copy
 * is explicit about that scope — patching also replays the original
 * failed delivery, so it shouldn't be a quiet click.
 */
export function InvestigationApprovalForm({
  dataContractId,
  currentVersion,
  patch,
  failedDelivery,
  samples,
}: {
  dataContractId: string;
  currentVersion: DataContractVersionRow;
  patch: ProposedPatch;
  failedDelivery: {
    event_id: string;
    source_id: string;
    route_id: string;
    r2_key: string;
  };
  samples: SampledEvent[];
}) {
  const router = useRouter();
  const approve = useAction(approvePatchAction, {
    onSuccess: (next) => {
      if (next.data?.dataContractId) router.refresh();
    },
  });
  const { pending, result } = approve;

  // Once a patch has been successfully applied, keep the button disabled so a
  // second click can't append a duplicate version + replay. A failed attempt
  // (result.error) leaves it enabled so the operator can edit and retry.
  const applied = Boolean(result && !result.error && (result.notice || result.data));
  const disabled = pending || patch.patch_kind === "none" || applied;

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
        <CheckCircle2 className="size-3.5" /> Apply patch + replay
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Approving creates a new Data Contract version with the proposed change,
        regenerates fixtures, runs the activation gate, and only queues the
        replay if every fixture passes. If a fixture fails, none of the steps
        commit — you can edit the patch and try again.
      </p>

      {result?.notice ? (
        <Alert className="mb-3">
          <CheckCircle2 className="size-4" />
          <AlertTitle>Approved</AlertTitle>
          <AlertDescription>
            {result.notice}{" "}
            {result.data?.versionId ? (
              <span className="text-muted-foreground">
                New version{" "}
                <code className="font-mono text-foreground">
                  {result.data.versionId}
                </code>
                .
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {result?.error ? (
        <Alert variant="destructive" className="mb-3">
          <ShieldAlert className="size-4" />
          <AlertTitle>
            {result.fixture_failures ? "Fixture gate refused" : "Could not apply patch"}
          </AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push("/deliveries")}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() =>
            approve.run({
              dataContractId,
              patch,
              currentVersion,
              failedDeliveries: [failedDelivery],
              samples,
            })
          }
        >
          {pending ? "Applying patch…" : "Approve & replay"}
        </Button>
      </div>
    </section>
  );
}
