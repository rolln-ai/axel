import { Bell } from "lucide-react";
import { requireSession } from "../../../lib/session";
import {
  listNotifications,
  type NotificationRow as NotificationRecord,
} from "../../../lib/notifications";
import { LocalTime } from "../../_components/LocalTime";
import { SeverityBadge } from "../../_components/StatusBadges";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { NotificationRow } from "./NotificationRow";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const userId = session.user.id;
  const notifications = await listNotifications(workspaceId, userId, {
    limit: 100,
  });
  const anyUnread = notifications.some((n) => n.read_at === null);

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Notifications
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drift alerts and delivery-failure investigations land here.
          </p>
        </div>
        {anyUnread ? <MarkAllReadButton /> : null}
      </div>
      {notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <Bell className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <h2 className="mt-3 text-lg font-medium text-foreground">All caught up</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            New drift alerts will show up here as Axel detects them.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} />
          ))}
        </ul>
      )}
    </>
  );
}

function NotificationItem({ notification }: { notification: NotificationRecord }) {
  return (
    <li>
      <NotificationRow
        id={notification.id}
        linkPath={notification.link_path}
        isUnread={notification.read_at === null}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          {notification.read_at === null ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-primary"
            />
          ) : (
            <span aria-hidden className="size-2 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {notification.title}
              </span>
              <SeverityBadge severity={notification.severity} />
            </div>
            {notification.body_md ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {notification.body_md}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            <LocalTime value={notification.created_at} />
          </span>
        </div>
      </NotificationRow>
    </li>
  );
}
