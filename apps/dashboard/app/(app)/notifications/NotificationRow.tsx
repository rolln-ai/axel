"use client";

import { useRouter } from "next/navigation";
import { markNotificationReadAction } from "./actions";
import { useAction } from "../../_components/useAction";
import { useActionStateToast } from "../../_components/Toast";

/**
 * Client wrapper for a single notification row. Clicking marks the
 * notification read (fire-and-forget) and, when it carries a link_path,
 * navigates there. Rows without a link_path still mark read on click.
 * "Mark all read" continues to work independently via MarkAllReadButton.
 */
export function NotificationRow({
  id,
  linkPath,
  isUnread,
  children,
}: {
  id: string;
  linkPath: string | null;
  isUnread: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const markRead = useAction(
    async (notificationId: string) => {
      try {
        await markNotificationReadAction(notificationId);
        return {};
      } catch {
        // The user may already have navigated via linkPath below — a toast
        // is the only surface that still reaches them if mark-read fails.
        return {
          error: "Couldn't mark the notification as read. It will stay unread — try again.",
        };
      }
    },
    { onSuccess: () => router.refresh() },
  );
  useActionStateToast({ error: markRead.error });

  function handleClick() {
    if (isUnread) markRead.run(id);
    if (linkPath) router.push(linkPath);
  }

  return (
    <div
      role={linkPath ? "link" : "button"}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className="block cursor-pointer hover:bg-muted/50"
    >
      {children}
    </div>
  );
}
