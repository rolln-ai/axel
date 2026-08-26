import { redirect } from "next/navigation";
import { PageHeader } from "../../_components/PageHeader";
import { requireSession } from "../../../lib/session";
import { loadWorkspaceBillingState } from "../../../lib/billing/state";
import { hasStripeConfigured } from "../../../lib/billing/stripe-client";
import { listFlushableDestinations } from "../../../lib/data-reset";
import { listPersonalAccessTokens } from "../../../lib/pat-actions";
import { BillingPanel } from "./BillingPanel";
import { CheckoutReturnNotice } from "./CheckoutReturnNotice";
import { deriveCheckoutReturnNotice } from "../../../lib/billing/checkout-return-notice";
import { DataResetPanel } from "./DataResetPanel";
import { ErasureRequestPanel } from "./ErasureRequestPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { PersonalAccessTokensPanel } from "./PersonalAccessTokensPanel";
import { RetentionSettingsPanel } from "./RetentionSettingsPanel";
import { NotificationPreferencesPanel } from "./NotificationPreferencesPanel";
import { WorkspaceSettingsForm } from "./WorkspaceSettingsForm";
import { CookiePreferencesButton } from "../../_components/CookiePreferencesButton";
import { db } from "../../../lib/db";
import { getNotificationPreferences } from "../../../lib/notifications";
import { listApiKeys } from "../../../lib/api-keys";
import { Badge } from "@/components/ui/badge";
import { reconcileCompletedCheckout } from "../../../lib/billing/checkout";
import { captureDashboardException } from "../../../lib/sentry-capture";

export const dynamic = "force-dynamic";

type SettingsTab =
  | "general"
  | "billing"
  | "notifications"
  | "api-keys"
  | "access-tokens"
  | "retention"
  | "danger";

function normalizeSettingsTab(raw: string | undefined): SettingsTab {
  if (
    raw === "billing" ||
    raw === "notifications" ||
    raw === "api-keys" ||
    raw === "access-tokens" ||
    raw === "retention" ||
    raw === "danger"
  ) {
    return raw;
  }
  // Backwards-compat: the danger tab was previously ?tab=data.
  if (raw === "data") return "danger";
  return "general";
}

/**
 * Workspace settings. URL-driven sections (`?tab=...`) so the
 * AppNav settings subnav can deep-link to any section. The bare
 * /settings URL lands on General — Workspace details + signed-in
 * account info.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    checkout?: string;
    checkout_session_id?: string;
  }>;
}) {
  const params = await searchParams;
  const rawTab = params.tab;
  // Canonicalise the legacy ?tab=data alias so the subnav active-highlight
  // (which matches on the raw query) lines up with the rendered section.
  if (rawTab === "data") redirect("/settings?tab=danger");
  const tab = normalizeSettingsTab(rawTab);
  const session = await requireSession();
  const canEditWorkspace = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  // Stripe can redirect before customer.subscription.created reaches our
  // webhook. Reconcile the completed session on the return request, then issue
  // a clean redirect so the very first rendered Billing page reads the updated
  // Pro state (and does not leave the Checkout Session id in the address bar).
  if (
    tab === "billing"
    && params.checkout === "success"
    && params.checkout_session_id
    && session.activeWorkspace.role === "owner"
  ) {
    let reconciled = false;
    try {
      await reconcileCompletedCheckout({
        workspaceId: session.activeWorkspace.workspace_id,
        checkoutSessionId: params.checkout_session_id,
      });
      reconciled = true;
    } catch (err) {
      // The webhook remains the durable fallback. Capture the failed fast-path
      // without exposing the Checkout Session id in logs/tags.
      await captureDashboardException(err, {
        tags: {
          component: "billing_checkout_return",
          workspace_id: session.activeWorkspace.workspace_id,
        },
      });
    }
    if (reconciled) redirect("/settings?tab=billing&checkout=success");
  }

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description={SECTION_DESCRIPTIONS[tab]}
      />

      {tab === "general" ? (
        <GeneralSection
          name={session.activeWorkspace.workspace_name}
          timezone={session.activeWorkspace.workspace_timezone}
          workspaceId={session.activeWorkspace.workspace_id}
          role={session.activeWorkspace.role}
          canEdit={canEditWorkspace}
          email={session.user.email}
          userName={session.user.name}
        />
      ) : null}

      {tab === "billing" ? (
        <BillingSection
          workspaceId={session.activeWorkspace.workspace_id}
          isOwner={session.activeWorkspace.role === "owner"}
          checkout={params.checkout}
        />
      ) : null}

      {tab === "notifications" ? (
        <NotificationsSection
          workspaceId={session.activeWorkspace.workspace_id}
          userId={session.user.id}
        />
      ) : null}

      {tab === "retention" ? (
        <RetentionSection
          workspaceId={session.activeWorkspace.workspace_id}
          canEdit={canEditWorkspace}
        />
      ) : null}

      {tab === "api-keys" ? (
        <ApiKeysSection
          workspaceId={session.activeWorkspace.workspace_id}
          canEdit={canEditWorkspace}
        />
      ) : null}

      {tab === "access-tokens" ? <AccessTokensSection /> : null}

      {tab === "danger" ? (
        <DataSection
          workspaceId={session.activeWorkspace.workspace_id}
          workspaceName={session.activeWorkspace.workspace_name}
          role={session.activeWorkspace.role as "owner" | "admin" | "member"}
          isLastWorkspace={
            // Matches deleteCurrentWorkspace's post-delete routing: it switches
            // to another ACTIVE workspace if one exists, else goes to /welcome.
            !session.memberships.some(
              (m) => m.workspace_id !== session.activeWorkspace.workspace_id && m.workspace_status === "active",
            )
          }
        />
      ) : null}
    </>
  );
}

const SECTION_DESCRIPTIONS: Record<SettingsTab, string> = {
  general: "Workspace preferences and account details.",
  billing: "Plan, current-period usage, and invoice history.",
  notifications: "Choose which alerts and digests Axel emails you.",
  retention: "How long Axel keeps event data before the hourly cleanup loop purges it.",
  "api-keys": "Workspace-scoped keys for the public /api/v1/* surface.",
  "access-tokens": "User-scoped tokens for the Axel CLI and personal scripts.",
  danger: "Destructive, irreversible operations — wipe event data, flush destinations, or delete the workspace.",
};

async function BillingSection({
  workspaceId,
  isOwner,
  checkout,
}: {
  workspaceId: string;
  isOwner: boolean;
  /** Raw ?checkout= param from the Stripe Checkout return redirect. */
  checkout: string | undefined;
}) {
  const state = await loadWorkspaceBillingState(workspaceId);
  const checkoutNotice = deriveCheckoutReturnNotice(checkout);
  return (
    <>
      {checkoutNotice ? <CheckoutReturnNotice notice={checkoutNotice} /> : null}
      <BillingPanel
        state={state}
        isOwner={isOwner}
        stripeConfigured={hasStripeConfigured()}
      />
    </>
  );
}

function GeneralSection({
  name,
  timezone,
  workspaceId,
  role,
  canEdit,
  email,
  userName,
}: {
  name: string;
  timezone: string;
  workspaceId: string;
  role: string;
  canEdit: boolean;
  email: string;
  userName: string;
}) {
  return (
    <>
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
          <Badge variant="outline" className="capitalize">{role}</Badge>
        </div>
        <div className="space-y-4 p-5">
          <WorkspaceSettingsForm
            name={name}
            timezone={timezone}
            workspaceId={workspaceId}
            canEdit={canEdit}
          />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Current user</h2>
        </div>
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Signed in as</p>
            <strong className="block text-base font-semibold text-foreground">{email}</strong>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Name</p>
            <strong className="block text-base font-semibold text-foreground">{userName}</strong>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Privacy</h2>
        </div>
        <div className="p-5">
          <p className="mb-3 text-sm text-muted-foreground">
            Change or withdraw the analytics cookie consent for this browser.
          </p>
          <div className="max-w-56 rounded-md border border-border">
            <CookiePreferencesButton />
          </div>
        </div>
      </section>
    </>
  );
}

async function NotificationsSection({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  const prefs = await getNotificationPreferences(workspaceId, userId);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Email notifications</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          We only email when something genuinely needs you — and never the same thing twice.
        </p>
      </div>
      <div className="space-y-4 p-5">
        <NotificationPreferencesPanel current={prefs} />
      </div>
    </section>
  );
}

async function RetentionSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const retention = await db().query<{
    raw_payload_retention_days: number;
    dead_letter_retention_days: number;
    replay_request_retention_days: number;
    audit_log_retention_days: number;
  }>(
    `SELECT raw_payload_retention_days, dead_letter_retention_days,
            replay_request_retention_days, audit_log_retention_days
       FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const retentionRow = retention.rows[0] ?? {
    raw_payload_retention_days: 30,
    dead_letter_retention_days: 90,
    replay_request_retention_days: 30,
    audit_log_retention_days: 365,
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Retention</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Lower these to meet privacy / compliance requirements.
        </p>
      </div>
      <div className="space-y-4 p-5">
        <RetentionSettingsPanel current={retentionRow} canEdit={canEdit} />
      </div>
    </section>
  );
}

async function ApiKeysSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const apiKeys = await listApiKeys(workspaceId);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Workspace API keys</h2>
        <Badge variant="outline">/api/v1/*</Badge>
      </div>
      <div className="space-y-4 p-5">
        <ApiKeysPanel initialKeys={apiKeys} canManage={canEdit} />
      </div>
    </section>
  );
}

async function AccessTokensSection() {
  const personalAccessTokens = await listPersonalAccessTokens();
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Personal access tokens</h2>
      </div>
      <div className="space-y-4 p-5">
        <PersonalAccessTokensPanel initialTokens={personalAccessTokens} />
      </div>
    </section>
  );
}

async function DataSection({
  workspaceId,
  workspaceName,
  role,
  isLastWorkspace,
}: {
  workspaceId: string;
  workspaceName: string;
  role: "owner" | "admin" | "member";
  isLastWorkspace: boolean;
}) {
  const destinations = await listFlushableDestinations(workspaceId);
  return (
    <div className="space-y-8">
      <DataResetPanel
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        role={role}
        isLastWorkspace={isLastWorkspace}
        destinations={destinations}
      />
      <div className="border-t border-border pt-6">
        <ErasureRequestPanel role={role} />
      </div>
    </div>
  );
}
