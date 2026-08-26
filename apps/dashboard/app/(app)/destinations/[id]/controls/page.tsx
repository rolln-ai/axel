import { notFound } from "next/navigation";
import { requireSession } from "../../../../../lib/session";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { CircuitBreakerPanel } from "../CircuitBreakerPanel";
import { DeliveryControlsPanel } from "../DeliveryControlsPanel";

export const dynamic = "force-dynamic";

export default async function DestinationControlsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  const destination = await getDestinationSummary(id, workspaceId);
  if (!destination) notFound();

  return (
    <div className="space-y-6">
      <CircuitBreakerPanel
        destinationId={destination.id}
        state={destination.circuit_state}
        openedAt={destination.circuit_opened_at}
        consecutiveFailures={destination.circuit_consecutive_failures}
        thresholdFailures={destination.circuit_threshold_failures}
        cooldownSeconds={destination.circuit_cooldown_seconds}
        canMutate={canMutate}
      />
      <DeliveryControlsPanel
        destinationId={destination.id}
        paused={destination.delivery_paused}
        pausedReason={destination.delivery_paused_reason}
        rateLimitRps={destination.rate_limit_rps}
        requestTimeoutMs={destination.request_timeout_ms}
        retryAfterUntil={destination.retry_after_until}
        canMutate={canMutate}
      />
    </div>
  );
}
