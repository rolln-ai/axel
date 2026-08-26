import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center">
      <FileQuestion className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Not found</h2>
        <p className="text-sm text-muted-foreground">
          The resource you&rsquo;re looking for doesn&rsquo;t exist, was deleted, or doesn&rsquo;t
          belong to this workspace.
        </p>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
        <span className="text-border" aria-hidden="true">·</span>
        <Link href="/sources" className="text-muted-foreground hover:text-foreground">
          Sources
        </Link>
      </div>
    </div>
  );
}
