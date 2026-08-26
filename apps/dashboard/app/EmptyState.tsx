import * as React from "react";

export function EmptyState({
  title,
  body,
  action,
  glyph = "·",
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  glyph?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
      <span
        className="grid size-10 place-items-center rounded-full bg-muted text-lg text-muted-foreground"
        aria-hidden="true"
      >
        {glyph}
      </span>
      <strong className="text-sm font-semibold text-foreground">{title}</strong>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
