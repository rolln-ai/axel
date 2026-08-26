"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, LayoutGrid, Building2, Users, ScrollText, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

interface AdminNavLink {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const LINKS: ReadonlyArray<AdminNavLink> = [
  { href: "/admin/overview", label: "Overview", Icon: LayoutGrid },
  { href: "/admin/health", label: "Health", Icon: Activity },
  { href: "/admin/billing", label: "Billing", Icon: CreditCard },
  { href: "/admin/workspaces", label: "Workspaces", Icon: Building2 },
  { href: "/admin/users", label: "Users", Icon: Users },
  { href: "/admin/audit", label: "Audit", Icon: ScrollText },
];

export function AdminNav() {
  const pathname = usePathname();
  const links = LINKS;
  return (
    <nav aria-label="Admin" className="flex flex-col gap-1 py-2">
      <p className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">Manage</p>
      <ul className="flex flex-col gap-px">
        {links.map((link) => {
          const active = isActive(pathname, link.href);
          const Icon = link.Icon;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                prefetch
                className={cn(
                  "group flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
                <span className="flex-1 truncate">{link.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
