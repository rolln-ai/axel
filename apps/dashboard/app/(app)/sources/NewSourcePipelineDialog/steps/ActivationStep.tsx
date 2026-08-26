"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IngestActivityMonitor } from "../../[id]/IngestActivityMonitor";
import { TestEventRunner } from "../../[id]/TestEventRunner";
import { SecretRow, SigningSecretHint } from "./shared";

/**
 * Final wizard step — closes the activation loop right after the pipeline is
 * created, before the user leaves the dialog.
 *
 *  - source + route  → live-monitor the ingest endpoint; real events show up
 *    here as they arrive and the route delivers them
 *  - source, no route → same monitor, with a heads-up that nothing will
 *    deliver until a route exists (events still surface as ingested)
 */
export function ActivationStep({
  sourceId,
  ingestUrl,
  plaintextToken,
  webhookSigningSecret,
  hasRoute,
  onBack,
  onClose,
}: {
  sourceId: string;
  ingestUrl?: string;
  plaintextToken?: string;
  webhookSigningSecret?: string;
  hasRoute: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  // The wizard form is display:none'd on step 4, so the button that brought the
  // user here is gone — pull focus into this step and announce it so keyboard /
  // screen-reader users don't get dropped on <body>.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.focus();
  }, []);
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="group"
      aria-label="Activate your new source"
      className="space-y-5 outline-none"
    >
      <div className="space-y-3">
        {/* One-shot endpoint + secrets. Also shown on step 3, but that form is
            display:none on step 4, so repeat them here so they stay copyable on
            the go-live step. */}
        {ingestUrl || plaintextToken || webhookSigningSecret ? (
          <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3">
            <div
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-foreground"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" />
              <span>The Webhook URL contains your ingest token — copy it now. The ingest token and signing secret cannot be retrieved after you close this dialog.</span>
            </div>
            {ingestUrl && plaintextToken ? (
              <>
                <SecretRow
                  label="Webhook URL — point your provider here"
                  value={`${ingestUrl}?token=${plaintextToken}`}
                />
                <p className="text-[11px] text-muted-foreground">
                  Or POST to the Ingest URL with the token as an{" "}
                  <code className="font-mono">x-axel-token</code> header.
                </p>
              </>
            ) : null}
            {ingestUrl ? <SecretRow label="Ingest URL" value={ingestUrl} /> : null}
            {plaintextToken ? <SecretRow label="Ingest token" value={plaintextToken} /> : null}
            {webhookSigningSecret ? (
              <>
                <SecretRow label="Webhook signing secret" value={webhookSigningSecret} />
                <SigningSecretHint />
              </>
            ) : null}
          </div>
        ) : null}
        {/* Active proof, first: one click sends a sample payload through the
            real ingest path and surfaces the routing/delivery outcome. Before
            this, the step only WAITED for real provider traffic — which meant
            a new user had to leave, configure their provider, and come back
            before anything ever happened. */}
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium text-foreground">See it work now</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {hasRoute
              ? "One click sends a sample event through the real ingest path — it routes and delivers to your destination like live traffic, flagged as a test."
              : "One click sends a sample event through the real ingest path, flagged as a test."}
          </p>
          <TestEventRunner sourceId={sourceId} />
        </div>
        {ingestUrl && plaintextToken ? (
          <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Or send one yourself with curl
            </summary>
            <SecretRow
              label="curl"
              value={`curl -X POST "${ingestUrl}?token=${plaintextToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`}
            />
          </details>
        ) : null}
        {!hasRoute ? (
          <Alert>
            <AlertDescription>
              You created a source without a route, so events (including test ones) won&apos;t
              deliver anywhere yet. They&apos;re still ingested and stored — add a route on the{" "}
              <Link href="/routes" className="underline hover:text-foreground">
                Routes tab
              </Link>
              , then replay any events you&apos;ve already captured.
            </AlertDescription>
          </Alert>
        ) : null}
        <div>
          <p className="text-sm font-medium text-foreground">Then go live</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {hasRoute
              ? "Point your provider at the webhook URL above — you can do this any time, even after closing this dialog. Axel watches the ingest endpoint live: the moment a real event lands it shows up here, and the route delivers it to your destination."
              : "Point your provider at the webhook URL above — you can do this any time, even after closing this dialog. Axel watches the ingest endpoint live; events show up here as they arrive."}
          </p>
        </div>
        <IngestActivityMonitor sourceId={sourceId} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
