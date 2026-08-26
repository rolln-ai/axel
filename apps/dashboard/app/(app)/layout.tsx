import { Suspense, type ReactNode } from "react";
import { AppShell } from "../AppShell";
import { getAuthenticatedUser, getCurrentSession, type CurrentSession } from "../../lib/session";
import { PanelStackProvider } from "../_components/PanelStack";
import { ToastProvider } from "../_components/Toast";
import { CommandPaletteSetup } from "../_components/CommandPaletteSetup";
import { StopImpersonationBar } from "../(admin)/_components/StopImpersonationBar";
import { SuspendedWorkspaceBanner } from "../(admin)/_components/SuspendedWorkspaceBanner";
import { BillingBanner } from "./_components/BillingBanner";
import { VerifyEmailBanner } from "./_components/VerifyEmailBanner";
import { PostHogIdentify } from "./_components/PostHogIdentify";
import { redirect } from "next/navigation";
import { AppShellChromeSkeleton } from "./AppShellChromeSkeleton";

/**
 * Layout for every authenticated dashboard page. Owning the AppShell
 * here (instead of letting each page render its own) means:
 *
 *  1. The sidebar and header stay mounted across navigations — clicking
 *     between Sources / Destinations / Routes no longer repaints the chrome.
 *  2. We can sit a `loading.tsx` next to this file. When the user clicks a
 *     nav link, Next.js immediately swaps `{children}` for that loading UI
 *     while the next page's server component streams in. No more 30s of
 *     "did my click register?" — the URL flips and a skeleton appears
 *     instantly, then real content fills in.
 *
 * On a cold Supabase pool the session lookup can be 10-30s — historically
 * the layout `await`-ed that query inline, so the bare root `loading.tsx`
 * showed for the whole wait and Cmd+K didn't work. Now we hand the session
 * down as a Promise so the outer providers (`<ToastProvider>`,
 * `<CommandPaletteSetup>`) mount immediately and a chrome-shaped skeleton
 * stands in for the AppShell until the session resolves.
 *
 * `getCurrentSession()` is wrapped in React's `cache()` (see lib/session.ts),
 * so child pages calling it again for `workspace_id` etc. is free.
 */
export default function AppGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Start the session lookup but do NOT await — let the providers below
  // mount first. The Suspense boundary will resolve it asynchronously.
  const sessionPromise = getCurrentSession();
  return (
    /*
     * Provider order matters:
     *   - <ToastProvider> is outermost so any client component (forms,
     *     server-action wrappers, panels) can fire toasts. Toast portal
     *     mounts on document.body, sits above everything.
     *   - <CommandPaletteSetup> registers the global ⌘K palette; its
     *     own portal also mounts on body but sits below toasts. Mounting
     *     it ABOVE the session Suspense means Cmd+K works while the
     *     skeleton is showing — users can still navigate while we wait.
     *   - <AppShell> renders the persistent sidebar + header.
     *   - <PanelStackProvider> hosts the multi-panel side drawer used
     *     by detail surfaces (destinations, deliveries, sources,
     *     routes). Sits above AppShell chrome, below toasts + cmdk.
     */
    <ToastProvider>
      <CommandPaletteSetup>
        <Suspense fallback={<AppShellChromeSkeleton />}>
          <AuthenticatedShell sessionPromise={sessionPromise}>
            {children}
          </AuthenticatedShell>
        </Suspense>
      </CommandPaletteSetup>
    </ToastProvider>
  );
}

async function AuthenticatedShell({
  sessionPromise,
  children,
}: {
  sessionPromise: Promise<CurrentSession | null>;
  children: ReactNode;
}) {
  const session = await sessionPromise;
  if (!session) {
    // getCurrentSession() returns null both for signed-out users AND for a
    // signed-in user with zero workspace memberships (e.g. they just deleted
    // their last one). Send the latter to onboarding to create a new workspace
    // instead of an unexplained bounce to /login.
    const auth = await getAuthenticatedUser();
    redirect(auth ? "/welcome" : "/login");
  }
  return (
    <>
      {session.impersonator ? (
        <StopImpersonationBar
          impersonatorEmail={session.impersonator.email}
          viewingAs={session.user.email}
        />
      ) : (
        // Skip identify during impersonation so a support session doesn't
        // overwrite the customer's PostHog identity with staff activity.
        <PostHogIdentify
          distinctId={session.user.id}
          email={session.user.email}
          name={session.user.name}
          workspaceId={session.activeWorkspace.workspace_id}
          workspaceName={session.activeWorkspace.workspace_name}
        />
      )}
      <AppShell session={session}>
        <PanelStackProvider>
          {/* Unverified email: a persistent nudge, never a gate — the
              dashboard stays fully usable (low-friction onboarding). */}
          {session.user.emailVerifiedAt === null ? (
            <VerifyEmailBanner email={session.user.email} />
          ) : null}
          {session.activeWorkspace.workspace_status !== "active" ? (
            <SuspendedWorkspaceBanner workspaceName={session.activeWorkspace.workspace_name} />
          ) : (
            // Rendered server-side (no Suspense) so the banner — or its absence
            // — is in the first paint. `loadWorkspaceBillingState` is a cached
            // per-request pool call, so awaiting it inline is cheap, and it
            // avoids the ~52px above-the-fold pop-in that `fallback={null}`
            // streaming caused. See dashboard CLS audit.
            <BillingBanner workspaceId={session.activeWorkspace.workspace_id} />
          )}
          {children}
        </PanelStackProvider>
      </AppShell>
    </>
  );
}
