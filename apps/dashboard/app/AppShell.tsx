import Link from "@/app/_components/NavigationLink";
import { Suspense, type ReactNode } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { loadInboxGroups } from "../lib/inbox";
import { countUnreadBillingNotifications } from "../lib/notifications";
import type { CurrentSession } from "../lib/session";
import { AppNav } from "./AppNav";
import { Logo } from "./_brand/Logo";
import { CommandPaletteHint } from "./_components/CommandPaletteHint";
import { MobileSidebar } from "./_components/MobileSidebar";
import { SignOutButton } from "./_components/SignOutButton";
import { ThemeToggle } from "./_components/ThemeToggle";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export function AppShell({ session, children }: {
  session: CurrentSession;
  children: ReactNode;
}) {
  const sidebar = <SidebarContent session={session} />;

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <aside className="hidden md:sticky md:top-0 md:flex md:h-svh md:w-64 md:shrink-0 md:flex-col md:self-start md:border-r md:border-border md:bg-sidebar md:text-sidebar-foreground">
        {sidebar}
      </aside>

      <MobileSidebar>{sidebar}</MobileSidebar>

      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <div className="flex-1 px-4 py-4 pt-14 md:px-8 md:py-6 md:pt-6">
          {children}
        </div>
      </main>
    </div>
  );
}

async function loadUnmutedInboxCount(workspaceId: string): Promise<number> {
  try {
    const groups = await loadInboxGroups(workspaceId);
    return groups.filter((g) => g.muted_until === null).length;
  } catch {
    return 0;
  }
}

function SidebarContent({ session }: { session: CurrentSession }) {
  const initial = (session.user.email[0] ?? session.user.name?.[0] ?? "?").toUpperCase();
  const userName = session.user.name || session.user.email.split("@")[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 px-1"
          aria-label="Axel home"
        >
          <Logo size={20} />
          <span className="text-sm font-semibold tracking-tight">Axel</span>
        </Link>
        <WorkspaceSwitcher
          activeWorkspace={session.activeWorkspace}
          memberships={session.memberships}
        />
        <CommandPaletteHint />
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        <AppNav isSuperAdmin={session.user.isSuperAdmin} />
      </div>

      <div className="flex flex-col gap-2 border-t border-border px-3 pt-3 pb-4">
        <div className="flex items-center justify-between gap-2 pl-1 pr-0.5">
          <a
            href="/status"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-label="View system status (opens in new tab)"
          >
            <Activity className="size-3" aria-hidden="true" />
            System status
          </a>
          <div className="flex items-center gap-1">
            <Suspense fallback={<InboxFooterLink count={0} />}>
              <InboxAwareFooterLink
                workspaceId={session.activeWorkspace.workspace_id}
                userId={session.user.id}
              />
            </Suspense>
            <ThemeToggle />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
          <span
            className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-medium text-background"
            aria-hidden="true"
          >
            {initial}
          </span>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{userName}</span>
            <span className="truncate text-[11px] text-muted-foreground">{session.user.email}</span>
          </div>
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}

/**
 * Footer Inbox entry — sits where the notification bell used to live.
 * Links to the failed-deliveries Inbox with the unmuted-group count.
 */
function InboxFooterLink({ count }: { count: number }) {
  return (
    <Link
      href="/inbox"
      aria-label={count > 0 ? `Inbox — ${count} unresolved` : "Inbox"}
      className="relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
    >
      <AlertTriangle className="size-4" />
      {count > 0 ? (
        <Badge
          variant="default"
          className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 text-[10px]"
        >
          {count > 99 ? "99+" : count}
        </Badge>
      ) : null}
    </Link>
  );
}

async function InboxAwareFooterLink({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  // Badge = unresolved dead-letter groups + unread billing alerts, since
  // the Inbox page surfaces both. Each half is best-effort.
  const [deadLetters, billing] = await Promise.all([
    loadUnmutedInboxCount(workspaceId),
    countUnreadBillingNotifications(workspaceId, userId).catch(() => 0),
  ]);
  return <InboxFooterLink count={deadLetters + billing} />;
}
