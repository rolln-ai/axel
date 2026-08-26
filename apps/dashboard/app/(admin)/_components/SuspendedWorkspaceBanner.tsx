/**
 * Banner rendered above `(app)` page content when the active workspace has
 * been suspended by a super-admin. Mutating actions are blocked at the
 * server-action layer; this UI element makes the reason explicit so users
 * aren't left wondering why every form is erroring.
 */
export function SuspendedWorkspaceBanner({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="mb-4 rounded-md border border-amber-500/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
      <strong className="font-semibold">{workspaceName} is suspended.</strong>{" "}
      Sources are paused at the edge and write actions are disabled. Contact support to restore access.
    </div>
  );
}
