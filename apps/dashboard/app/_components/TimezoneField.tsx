/**
 * TimezoneField — hidden form input carrying the browser's IANA timezone.
 *
 * Why a client component:
 *   Only the browser knows the visitor's zone. The server renders in UTC, so
 *   a workspace created at signup would always default to UTC even for a user
 *   sitting in Denver. Dropping this field into a creation form lets the
 *   server seed `workspaces.timezone` from the browser instead.
 *
 * The value is filled in on mount (empty during SSR), so a no-JS submit — or
 * a browser without `Intl` — simply sends nothing and the server falls back
 * to UTC. It's a default, not a setting: Settings → General still owns the
 * authoritative value and users can change it there at any time.
 *
 * Usage:
 *   <form action={createWorkspace}>
 *     <TimezoneField />
 *     ...
 */
"use client";

import * as React from "react";

export function TimezoneField({ name = "timezone" }: { name?: string }) {
  const [timezone, setTimezone] = React.useState("");

  React.useEffect(() => {
    try {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
    } catch {
      // No Intl / no resolvable zone — leave empty, server defaults to UTC.
    }
  }, []);

  return <input type="hidden" name={name} value={timezone} readOnly suppressHydrationWarning />;
}
