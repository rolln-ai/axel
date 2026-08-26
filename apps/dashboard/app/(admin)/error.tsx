"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin]", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center"
    >
      <AlertTriangle className="size-8 text-destructive" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Admin page error</h2>
        <p className="text-sm text-muted-foreground">
          The admin view threw while loading. Retry — if it persists, check server logs.
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
          <a href="/admin">Admin home</a>
        </Button>
      </div>
    </div>
  );
}
