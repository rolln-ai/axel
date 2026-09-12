"use client";

import * as React from "react";
import { useLinkStatus } from "next/link";
import Link from "./_components/NavigationLink";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Inbox,
  SendHorizontal,
  Workflow,
  ListChecks,
  Radio,
  BarChart3,
  Users,
  Settings,
  ShieldAlert,
  Map as MapIcon,
  AlertTriangle,
  Activity,
  Key,
  Database,
  Sparkles,
  Sliders,
  Cog,
  CalendarCheck,
  Send,
  Webhook,
  Cable,
  FileText,
  CreditCard,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DetailSubnav, type DetailSubnavSection } from "./_components/DetailSubnav";

type NavSection = "activity" | "pipeline" | "workspace" | "admin";

interface NavLinkDef {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  section: NavSection;
  shortcut?: string;
}

const SECTION_LABELS: Record<NavSection, string> = {
  activity: "Activity",
  pipeline: "Pipeline",
  workspace: "Workspace",
  admin: "Platform",
};

const SECTION_ORDER: ReadonlyArray<NavSection> = ["activity", "pipeline", "workspace", "admin"];

const LINKS: ReadonlyArray<NavLinkDef> = [
  { href: "/dashboard",    label: "Overview",     Icon: LayoutGrid,     section: "activity",  shortcut: "O" },
  { href: "/events",       label: "Events",       Icon: Radio,          section: "activity",  shortcut: "V" },
  { href: "/deliveries",   label: "Deliveries",   Icon: ListChecks,     section: "activity",  shortcut: "E" },
  { href: "/sources",      label: "Sources",      Icon: Inbox,          section: "pipeline",  shortcut: "S" },
  { href: "/routes",       label: "Pipelines",    Icon: Workflow,       section: "pipeline",  shortcut: "R" },
  { href: "/destinations", label: "Destinations", Icon: SendHorizontal, section: "pipeline",  shortcut: "D" },
  { href: "/data-contracts",   label: "Data Contracts",   Icon: MapIcon,        section: "pipeline",  shortcut: "M" },
  { href: "/usage",        label: "Usage",        Icon: BarChart3,      section: "workspace" },
  { href: "/team",         label: "Team",         Icon: Users,          section: "workspace" },
  { href: "/settings",     label: "Settings",     Icon: Settings,       section: "workspace" },
  { href: "/admin",        label: "Admin",        Icon: ShieldAlert,    section: "admin" },
];

export function AppNav({ isSuperAdmin = false }: { isSuperAdmin?: boolean }) {
  const pathname = usePathname();
  const detailNav = detectDetailNav(pathname);
  if (detailNav) {
    return (
      <DetailSubnav
        backHref={detailNav.backHref}
        backLabel={detailNav.backLabel}
        resourceLabel={detailNav.resourceLabel}
        sections={detailNav.sections}
      />
    );
  }
  return (
    <nav aria-label="Dashboard" data-dashboard-nav="ready" className="flex flex-col gap-3 py-2">
      {SECTION_ORDER.map((section) => {
        if (section === "admin" && !isSuperAdmin) return null;
        const links = LINKS.filter((l) => l.section === section);
        if (links.length === 0) return null;
        return (
          <div key={section} className="flex flex-col gap-1">
            <p className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
              {SECTION_LABELS[section]}
            </p>
            <ul className="flex flex-col gap-px">
              {links.map((link) => {
                const active = isActive(pathname, link.href);
                const Icon = link.Icon;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <NavLinkBody
                        icon={<Icon className={cn("size-4 shrink-0", active && "text-primary")} />}
                        label={link.label}
                        shortcut={link.shortcut}
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NavLinkBody({
  icon,
  label,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  const { pending } = useLinkStatus();
  return (
    <span className={cn("flex flex-1 items-center gap-2", pending && "opacity-60")}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? (
        <kbd className="hidden font-mono text-[10px] text-muted-foreground group-hover:inline">
          {shortcut}
        </kbd>
      ) : null}
    </span>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface DetailNav {
  backHref: string;
  backLabel: string;
  resourceLabel: string;
  sections: DetailSubnavSection[];
}

/**
 * Pattern-match the pathname against the detail-page surfaces. Returns
 * the appropriate subnav config or `null` to fall through to the
 * top-level nav.
 *
 * Each subnav uses the bare resource URL as the "Overview" entry
 * (`exact: true`) so deeper paths like `/destinations/[id]/credential`
 * highlight the right link.
 */
function detectDetailNav(pathname: string | null): DetailNav | null {
  if (!pathname) return null;

  const destMatch = pathname.match(/^\/destinations\/([^/]+)(?:\/|$)/);
  if (destMatch && destMatch[1] && destMatch[1] !== "new") {
    const id = destMatch[1];
    return {
      backHref: "/destinations",
      backLabel: "All destinations",
      resourceLabel: "Destination",
      sections: [
        { href: `/destinations/${id}`, label: "Overview", Icon: LayoutGrid, exact: true },
        { href: `/destinations/${id}/health`, label: "Health", Icon: Activity },
        { href: `/destinations/${id}/configuration`, label: "Configuration", Icon: Cog },
        { href: `/destinations/${id}/credential`, label: "Credential", Icon: Key },
        { href: `/destinations/${id}/data`, label: "Data viewer", Icon: Database },
        { href: `/destinations/${id}/controls`, label: "Delivery controls", Icon: Sliders },
      ],
    };
  }

  const sourceMatch = pathname.match(/^\/sources\/([^/]+)(?:\/|$)/);
  if (sourceMatch && sourceMatch[1] && sourceMatch[1] !== "new") {
    const id = sourceMatch[1];
    // Sources use ?tab= routing (legacy). Subnav links target the
    // existing query-param pattern so deep links keep working without
    // a file-per-tab restructure.
    return {
      backHref: "/sources",
      backLabel: "All sources",
      resourceLabel: "Source",
      sections: [
        { href: `/sources/${id}`, label: "Overview", Icon: LayoutGrid, exact: true },
        { href: `/sources/${id}?tab=contract`, label: "Data contract", Icon: MapIcon, exact: true },
        { href: `/sources/${id}?tab=ingest`, label: "Ingest", Icon: Webhook, exact: true },
        { href: `/sources/${id}?tab=sync`, label: "Sync", Icon: Cable, exact: true },
        { href: `/sources/${id}?tab=settings`, label: "Settings", Icon: Cog, exact: true },
      ],
    };
  }

  const routeMatch = pathname.match(/^\/routes\/([^/]+)(?:\/|$)/);
  if (routeMatch && routeMatch[1] && routeMatch[1] !== "new") {
    const id = routeMatch[1];
    return {
      backHref: "/routes",
      backLabel: "All pipelines",
      resourceLabel: "Pipeline",
      sections: [
        { href: `/routes/${id}`, label: "Overview", Icon: LayoutGrid, exact: true },
        { href: `/routes/${id}?tab=destinations`, label: "Destinations", Icon: SendHorizontal, exact: true },
        { href: `/routes/${id}?tab=test`, label: "Test", Icon: Send, exact: true },
        { href: `/routes/${id}?tab=backfill`, label: "Backfill", Icon: CalendarCheck, exact: true },
        { href: `/routes/${id}?tab=events`, label: "Recent events", Icon: FileText, exact: true },
      ],
    };
  }

  const contractMatch = pathname.match(/^\/data-contracts\/([^/]+)(?:\/|$)/);
  if (contractMatch && contractMatch[1] && contractMatch[1] !== "new") {
    const id = contractMatch[1];
    return {
      backHref: "/data-contracts",
      backLabel: "All Data Contracts",
      resourceLabel: "Data Contract",
      sections: [
        { href: `/data-contracts/${id}`, label: "Overview", Icon: LayoutGrid, exact: true },
        { href: `/data-contracts/${id}?tab=mapping`, label: "Destination mapping", Icon: SendHorizontal, exact: true },
        { href: `/data-contracts/${id}?tab=codegen`, label: "Codegen", Icon: Sparkles, exact: true },
        { href: `/data-contracts/${id}?tab=schema`, label: "Schema", Icon: FileText, exact: true },
        { href: `/data-contracts/${id}?tab=versions`, label: "Versions", Icon: CalendarCheck, exact: true },
      ],
    };
  }

  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return {
      backHref: "/dashboard",
      backLabel: "Dashboard",
      resourceLabel: "Settings",
      sections: [
        { href: "/settings", label: "General", Icon: Cog, exact: true },
        { href: "/settings?tab=billing", label: "Billing", Icon: CreditCard, exact: true },
        { href: "/settings?tab=notifications", label: "Notifications", Icon: Bell, exact: true },
        { href: "/settings?tab=api-keys", label: "API keys", Icon: Key, exact: true },
        { href: "/settings?tab=access-tokens", label: "Personal access tokens", Icon: Key, exact: true },
        { href: "/settings?tab=retention", label: "Retention", Icon: CalendarCheck, exact: true },
        { href: "/settings?tab=danger", label: "Danger", Icon: AlertTriangle, exact: true },
      ],
    };
  }

  return null;
}
