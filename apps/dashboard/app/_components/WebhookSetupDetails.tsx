"use client";

import Link from "next/link";
import type { SourceProvider } from "@axel/shared";
import { CopyButton } from "../(app)/_components/CopyButton";
import { useToast } from "./Toast";
import { sourceAuthenticationCopy, sourceUsesAxelToken } from "../../lib/source-ingest-auth";

/**
 * Complete webhook setup shared by source settings, first-run setup, and both
 * wizard activation panels. Replaces separate URL/token rows whose request
 * examples could keep showing a placeholder after a token was generated.
 * One-shot credentials stay in the caller's React state, never browser storage.
 */
export function WebhookSetupDetails({
  ingestUrl,
  provider,
  token,
  sourceId,
}: {
  ingestUrl: string;
  provider: SourceProvider;
  token?: string | null;
  sourceId?: string;
}) {
  const usesToken = sourceUsesAxelToken(provider);
  return (
    <div className="min-w-0 space-y-3">
      <CopyableWebhookValue label="Webhook URL" value={ingestUrl} copyLabel="Copy URL" />
      {usesToken ? (
        <>
          <CopyableWebhookValue label="Header name" value="x-axel-token" copyLabel="Copy header name" />
          {token ? (
            <CopyableWebhookValue label="Header value" value={token} copyLabel="Copy header value" />
          ) : (
            <p className="text-xs text-muted-foreground">
              Use your saved token as the header value. If you no longer have it, rotate the token
              to get a new value.
            </p>
          )}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{sourceAuthenticationCopy(provider)}</p>
      {usesToken && sourceId ? (
        <Link href={`/sources/${sourceId}?tab=settings`} className="inline-block text-xs underline hover:text-foreground">
          Set up a sender that cannot send headers
        </Link>
      ) : null}
    </div>
  );
}

export function CopyableWebhookValue({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const toast = useToast();
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-foreground">{label}</div>
      <div className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed select-all">{value}</code>
        <CopyButton
          value={value}
          label={copyLabel}
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onCopyError={() => toast.error("Couldn't copy. Select the text and copy it manually.")}
        />
      </div>
    </div>
  );
}
