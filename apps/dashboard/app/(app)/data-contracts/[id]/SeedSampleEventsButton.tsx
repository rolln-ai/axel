"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { seedSampleEvents, type ActionState } from "../../../../lib/seed-sample-events";
import { ConfirmAction } from "../../../_components/ConfirmAction";

/**
 * "Seed sample events" — fires all 30+ provider payloads (Stripe,
 * GitHub, Shopify, Linear, Slack, Twilio, SendGrid, Chargebee) into
 * the bound source so the operator can watch the Data Contract jump from
 * 1 cluster to 25+ in one click. Pairs with RefreshDataContractButton:
 * Seed → Refresh → done.
 */
export function SeedSampleEventsButton({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(seedSampleEvents, {});

  return (
    <div className="space-y-2">
      <form
        action={action}
        onSubmit={() => {
          // After submit, refresh so any side-effects (e.g. event count changes)
          // surface on the page.
          setTimeout(() => router.refresh(), 1500);
        }}
      >
        <input type="hidden" name="source_id" value={sourceId} />
        <ConfirmAction
          title="Seed sample events"
          body="Fire 30+ sample events into this source? They're marked as test events and won't fan out to live destinations."
          confirmLabel="Seed events"
        >
          <Button type="button" variant="outline" size="sm" disabled={pending} className="gap-1.5">
            <Sparkles className={`size-3.5 ${pending ? "animate-pulse" : ""}`} />
            {pending ? "Seeding…" : "Seed 30+ sample events"}
          </Button>
        </ConfirmAction>
      </form>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
