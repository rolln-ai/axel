import { stopImpersonationAction } from "../../../lib/admin-actions";

/**
 * Persistent top bar shown whenever the current session is impersonating
 * another user. Rendered by `(app)/layout.tsx` (and also by the admin
 * layout for symmetry). The bar is the anti-forget defense: high-contrast
 * red + always visible, with a single button to revert.
 */
export function StopImpersonationBar({ impersonatorEmail, viewingAs }: {
  impersonatorEmail: string;
  viewingAs: string;
}) {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-red-700 bg-red-700 px-4 py-1.5 text-xs text-white">
      <span className="truncate">
        <strong className="font-semibold">Impersonation active</strong>
        <span className="opacity-90"> — {impersonatorEmail} viewing as {viewingAs}</span>
      </span>
      <form action={stopImpersonationAction}>
        <button
          type="submit"
          className="shrink-0 rounded-md bg-white/15 px-2 py-0.5 text-xs font-medium text-white hover:bg-white/25"
        >
          Stop impersonating
        </button>
      </form>
    </div>
  );
}
