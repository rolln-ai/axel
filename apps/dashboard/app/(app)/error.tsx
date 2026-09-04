"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for every authenticated dashboard page. Without this,
 * a thrown server-component error renders Next.js's bare-bones default
 * which sits awkwardly inside our AppShell and gives the user no path
 * forward. This catches the throw, logs it (Sentry picks server errors
 * up via instrumentation; this `console.error` is the client-side log),
 * and gives the user a retry + escape hatch.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] route error");
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center"
    >
      <AlertTriangle className="size-8 text-destructive" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">
          This page hit an error while loading. Try again — if it keeps failing, refresh or check
          the status page.
        </p>
      </div>
      {error.digest ? (
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {error.digest}
        </code>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={() => reset()} variant="default" size="sm">
          Try again
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href="/dashboard">Back to dashboard</a>
        </Button>
      </div>
    </div>
  );
}
