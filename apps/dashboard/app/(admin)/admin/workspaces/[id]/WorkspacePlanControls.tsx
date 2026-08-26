"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionState } from "../../../../../lib/action-data";
import { setWorkspacePlanAction, setWorkspaceBillingExemptAction } from "../../../../../lib/admin-actions";
import { ConfirmAction } from "../../../../_components/ConfirmAction";

interface WorkspacePlanControlsProps {
  workspaceId: string;
  currentPlan: "free" | "pro" | "enterprise";
  billingStatus: "ok" | "past_due" | "grace" | "suspended" | "canceled";
  billingExempt: boolean;
}

/**
 * Super-admin override panel for the workspace's pricing plan. Sits
 * on /admin/workspaces/[id] alongside Suspend / Delete. Sets the
 * `plan` column directly — bypasses Stripe Checkout — so comp
 * upgrades, internal workspaces, and hand-rolled enterprise deals
 * don't need a card on file. After the change the action pushes the
 * fresh plan_state to the ingest worker so the new cap takes effect
 * within seconds.
 */
export function WorkspacePlanControls({
  workspaceId,
  currentPlan,
  billingStatus,
  billingExempt,
}: WorkspacePlanControlsProps) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setWorkspacePlanAction,
    {},
  );
  const [exemptState, exemptAction, exemptPending] = useActionState<ActionState, FormData>(
    setWorkspaceBillingExemptAction,
    {},
  );

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Plan override</h2>
        <div className="flex items-center gap-2">
          <Badge className="capitalize" variant={currentPlan === "pro" ? "default" : "outline"}>
            {currentPlan}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            billing: {billingStatus.replace("_", " ")}
          </Badge>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sets the plan column directly. Does NOT create or change a Stripe subscription.
        Use Free for comp downgrades, Enterprise for hand-rolled deals (no 10k cap,
        no Stripe billing), Pro to bypass Checkout for comp upgrades.
      </p>

      {state.error ? (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert className="mt-3">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-4 grid grid-cols-3 gap-2">
        <PlanButton
          plan="free"
          label="Free"
          active={currentPlan === "free"}
          pending={pending}
          action={action}
          workspaceId={workspaceId}
        />
        <PlanButton
          plan="pro"
          label="Pro"
          active={currentPlan === "pro"}
          pending={pending}
          action={action}
          workspaceId={workspaceId}
        />
        <PlanButton
          plan="enterprise"
          label="Enterprise"
          active={currentPlan === "enterprise"}
          pending={pending}
          action={action}
          workspaceId={workspaceId}
        />
      </div>

      {/* Billing exemption — comp a workspace entirely (no card, no quota, no suspension). */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Billing exemption</h3>
          <Badge variant={billingExempt ? "default" : "outline"} className="text-[10px]">
            {billingExempt ? "exempt" : "billed normally"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          When exempt, the ingest gate always accepts: no payment method required, the free-tier
          task cap is ignored, and the workspace is never auto-suspended for non-payment. For
          internal / test spaces.
        </p>

        {exemptState.error ? (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{exemptState.error}</AlertDescription>
          </Alert>
        ) : null}
        {exemptState.notice ? (
          <Alert className="mt-3">
            <AlertDescription>{exemptState.notice}</AlertDescription>
          </Alert>
        ) : null}

        <form action={exemptAction} className="mt-3">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="exempt" value={billingExempt ? "false" : "true"} />
          <ConfirmAction
            title={billingExempt ? "Remove billing exemption" : "Make billing-exempt"}
            body={
              billingExempt
                ? "Remove the billing exemption? The workspace returns to normal billing: payment required, free-tier cap enforced, and auto-suspension for non-payment."
                : "Make this workspace billing-exempt? No payment method required, the task cap is ignored, and it will never be auto-suspended for non-payment."
            }
            confirmLabel={billingExempt ? "Remove exemption" : "Make exempt"}
          >
            <Button
              type="button"
              variant={billingExempt ? "outline" : "default"}
              size="sm"
              disabled={exemptPending}
            >
              {exemptPending
                ? "Updating…"
                : billingExempt
                  ? "Remove exemption"
                  : "Make billing-exempt"}
            </Button>
          </ConfirmAction>
        </form>
      </div>
    </div>
  );
}

function PlanButton({
  plan,
  label,
  active,
  pending,
  action,
  workspaceId,
}: {
  plan: "free" | "pro" | "enterprise";
  label: string;
  active: boolean;
  pending: boolean;
  action: (formData: FormData) => void;
  workspaceId: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <input type="hidden" name="plan" value={plan} />
      <ConfirmAction
        title="Set plan"
        body={`Set this workspace's plan to ${label}? This writes the plan column directly and bypasses Stripe — quota and billing change within seconds.`}
        confirmLabel={`Set ${label}`}
      >
        <Button
          type="button"
          variant={active ? "default" : "outline"}
          size="sm"
          className="w-full"
          disabled={active || pending}
        >
          {active ? `Current: ${label}` : pending ? "Updating…" : `Set ${label}`}
        </Button>
      </ConfirmAction>
    </form>
  );
}
