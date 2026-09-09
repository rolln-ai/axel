"use client";

import { useActionState } from "react";
import type { SourceProvider } from "@axel/shared";
import { rotateSourceToken, updateSourceUrlToken } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ConfirmAction } from "../../../_components/ConfirmAction";
import { CopyableWebhookValue, WebhookSetupDetails } from "../../../_components/WebhookSetupDetails";
import {
  sourceAuthenticatedUrl,
  sourceProviderLabel,
  sourceUsesAxelToken,
} from "../../../../lib/source-ingest-auth";

interface Props {
  sourceId: string;
  ingestUrl: string;
  canRotate: boolean;
  urlTokenEnabled?: boolean;
  /** AXE-23 — provider preset configured on the source. */
  provider?: SourceProvider;
  /** Short hex digest of the provider signing secret, if configured. */
  signingSecretFingerprint?: string | null;
}

export function SourceTokenPanel({
  sourceId,
  ingestUrl,
  canRotate,
  urlTokenEnabled = false,
  provider = "custom",
  signingSecretFingerprint = null,
}: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(rotateSourceToken, {});
  const [urlState, urlAction, urlPending] = useActionState<ActionState, FormData>(updateSourceUrlToken, {});
  const usesAxelToken = sourceUsesAxelToken(provider);
  const urlEnabled = urlState.data?.urlTokenEnabled ?? urlTokenEnabled;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">{usesAxelToken ? "With a custom header" : "Webhook setup"}</Label>
        <div className="min-w-0 space-y-3">
          {state.notice ? <p role="status" className="text-sm">{state.notice}</p> : null}
          <WebhookSetupDetails ingestUrl={ingestUrl} provider={provider} token={state.data?.plaintextToken} />
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Inbound authentication</Label>
        <div className="space-y-2">
          {signingSecretFingerprint ? (
            <p className="text-xs text-foreground">
              <strong className="font-semibold capitalize">{sourceProviderLabel(provider)}</strong>{" "}
              provider authentication active.
              <span className="ml-1 font-mono text-muted-foreground">
                (fingerprint {signingSecretFingerprint})
              </span>
            </p>
          ) : provider === "custom" ? (
            <p className="text-xs text-muted-foreground">
              A valid source credential is required. No additional provider signature is configured.
            </p>
          ) : (
            <p className="text-xs text-destructive">
              {sourceProviderLabel(provider)} authentication is misconfigured. Requests are rejected
              until an owner or admin repairs the provider credential.
            </p>
          )}
        </div>
      </div>

      {usesAxelToken ? (
        <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
          <Label className="pt-2 text-sm font-medium">Header token</Label>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Rotating replaces the header token immediately. Copy the new value and update each
              sender that uses this header.
            </p>

            {state.error ? (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}
            <form action={action}>
              <input type="hidden" name="source_id" value={sourceId} />
              <ConfirmAction
                title="Rotate source token"
                body="The previous header token will stop working immediately. Update every sender that uses it with the new value."
                confirmLabel="Rotate"
                destructive
              >
                <Button type="button" variant="secondary" disabled={!canRotate || pending}>
                  {pending ? "Rotating…" : "Rotate token"}
                </Button>
              </ConfirmAction>
            </form>
            {!canRotate ? (
              <p className="text-xs text-muted-foreground">
                Only owners and admins can rotate source tokens.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {usesAxelToken ? (
        <div className="grid gap-2 border-t border-border pt-4 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
          <Label className="pt-2 text-sm font-medium">Without custom headers</Label>
          <div className="min-w-0 space-y-3">
            <p className="text-sm">Generate a complete webhook URL for a sender that cannot set headers.</p>
            <p className="text-xs text-muted-foreground">
              Keep this URL private. Anyone with it can send events to this source, and your sender
              may record it in its logs. Header authentication stays unchanged.
              {signingSecretFingerprint ? " Your configured provider signature is still required." : ""}
            </p>
            {urlState.error ? <Alert variant="destructive"><AlertDescription>{urlState.error}</AlertDescription></Alert> : null}
            {urlState.notice ? <p role="status" className="text-sm">{urlState.notice}</p> : null}
            {urlState.data?.plaintextUrlToken ? (
              <CopyableWebhookValue
                label="Authenticated webhook URL"
                value={sourceAuthenticatedUrl(ingestUrl, urlState.data.plaintextUrlToken)}
                copyLabel="Copy authenticated URL"
              />
            ) : urlEnabled ? (
              <p className="text-xs text-muted-foreground">
                URL authentication is enabled. Keep using the URL saved in your sender, or generate
                a replacement if you no longer have it.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <form action={urlAction}>
                <input type="hidden" name="source_id" value={sourceId} />
                <input type="hidden" name="operation" value="generate" />
                {urlEnabled ? (
                  <ConfirmAction title="Replace webhook URL" body="The previous authenticated URL will stop working immediately. Copy the replacement URL into your sender. Header tokens are unchanged." confirmLabel="Replace URL" destructive>
                    <Button type="button" variant="secondary" disabled={!canRotate || urlPending}>Replace webhook URL</Button>
                  </ConfirmAction>
                ) : (
                  <Button type="submit" variant="secondary" disabled={!canRotate || urlPending}>
                    {urlPending ? "Generating…" : "Generate webhook URL"}
                  </Button>
                )}
              </form>
              {urlEnabled ? (
                <form action={urlAction}>
                  <input type="hidden" name="source_id" value={sourceId} />
                  <input type="hidden" name="operation" value="disable" />
                  <ConfirmAction title="Disable URL authentication" body="Senders using the authenticated URL will stop sending events to this source. Header tokens are unchanged." confirmLabel="Disable URL" destructive>
                    <Button type="button" variant="outline" disabled={!canRotate || urlPending}>Disable URL</Button>
                  </ConfirmAction>
                </form>
              ) : null}
            </div>
            {!canRotate ? <p className="text-xs text-muted-foreground">Only owners and admins can manage webhook URLs.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
