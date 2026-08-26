import Link from "next/link";
import { LogOut, ShieldAlert } from "lucide-react";
import { logOut } from "../../lib/auth-actions";
import type { AuthenticatedUser } from "../../lib/session";
import { Logo } from "../_brand/Logo";
import { AdminNav } from "./AdminNav";

export function AdminShell({ auth, children }: {
  auth: AuthenticatedUser;
  children: React.ReactNode;
}) {
  const initial = (auth.user.email[0] ?? auth.user.name?.[0] ?? "?").toUpperCase();
  const userName = auth.user.name || auth.user.email.split("@")[0];

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden md:sticky md:top-0 md:flex md:h-svh md:w-64 md:shrink-0 md:flex-col md:self-start md:border-r md:border-border md:bg-sidebar md:text-sidebar-foreground">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
            <Link href="/admin" className="flex items-center gap-2 px-1" aria-label="Axel admin home">
              <Logo size={20} />
              <span className="text-sm font-semibold tracking-tight">Axel</span>
              <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-red-600/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
                <ShieldAlert className="size-3" /> admin
              </span>
            </Link>
            <Link
              href="/dashboard"
              className="rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[11px] text-muted-foreground hover:bg-accent/40"
            >
              ← Back to dashboard
            </Link>
          </div>

          <div className="flex-1 overflow-y-auto px-3">
            <AdminNav />
          </div>

          <div className="flex flex-col gap-2 border-t border-border px-3 pt-3 pb-4">
            <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-medium text-background"
                aria-hidden="true"
              >
                {initial}
              </span>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-sm font-medium">{userName}</span>
                <span className="truncate text-[11px] text-muted-foreground">{auth.user.email}</span>
              </div>
            </div>
            <form action={logOut}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
                aria-label="Sign out"
              >
                <LogOut className="size-3.5" />
                <span>Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <div className="flex-1 px-4 py-4 md:px-8 md:py-6">{children}</div>
      </main>
    </div>
  );
}
