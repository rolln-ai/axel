import { CreditCard } from "lucide-react";
import {
  listUnreadBillingNotifications,
  type NotificationRow as NotificationRecord,
} from "../../../lib/notifications";
import { LocalTime } from "../../_components/LocalTime";
import { SeverityBadge } from "../../_components/StatusBadges";
import { NotificationRow } from "../notifications/NotificationRow";

/**
 * Unread billing alerts (quota warnings, payment failures, suspensions)
 * shown at the top of the Inbox. Billing problems block deliveries just
 * like dead letters do, so they triage from the same surface. Clicking a
 * row marks it read and follows its link (usually /settings?tab=billing).
 * Renders nothing when there's nothing unread.
 */
export async function BillingAlerts({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  let alerts: NotificationRecord[] = [];
  try {
    alerts = await listUnreadBillingNotifications(workspaceId, userId);
  } catch {
    return null; // best-effort strip; never block the inbox on it
  }
  if (alerts.length === 0) return null;

  return (
    <section aria-label="Billing alerts" className="mb-4">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <CreditCard className="size-3" aria-hidden />
        Billing
      </p>
      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {alerts.map((n) => (
          <li key={n.id}>
            <NotificationRow id={n.id} linkPath={n.link_path} isUnread>
              <div className="flex items-center gap-3 px-4 py-3">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{n.title}</span>
                    <SeverityBadge severity={n.severity} />
                  </div>
                  {n.body_md ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.body_md}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <LocalTime value={n.created_at} />
                </span>
              </div>
            </NotificationRow>
          </li>
        ))}
      </ul>
    </section>
  );
}
