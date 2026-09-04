"use client";

import { useState } from "react";
import type { SourceProvider } from "@axel/shared";
import { CheckCircle2, Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCopyToClipboard } from "../../../_components/CopyButton";
import { useToast } from "../../../../_components/Toast";
import {
  sourceAuthenticationCopy,
  sourceProviderLabel,
} from "../../../../../lib/source-ingest-auth";

export function SecretRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  const { copied, copy } = useCopyToClipboard({
    // Clipboard blocked — the select-all <pre> below is the manual fallback,
    // but say so instead of failing silently.
    onError: () =>
      toast.error("Couldn't copy to the clipboard. Select the text below and copy it manually."),
  });
  return (
    <div className="mt-2 min-w-0 space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={copied ? "Copied" : "Copy"}
          className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {copied ? (
            <CheckCircle2 className="size-3 text-emerald-600" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* break-all + whitespace-pre-wrap keeps long URLs and one-shot secrets
          inside the modal on narrow viewports. */}
      <pre className="w-full max-w-full whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[11px] leading-tight select-all">
        {value}
      </pre>
    </div>
  );
}

// Shared signing-secret verification explainer. Rendered in two places (the
// step-3 success alert and the step-4 activation panel), so it lives here to
// prevent the copy from drifting between the two. Do NOT rename the
// X-Axel-Signature header.
export function SigningSecretHint() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Axel signs every outbound delivery with HMAC-SHA256. Verify the{" "}
      <code className="font-mono">X-Axel-Signature</code> header on events delivered to your
      consumer — format{" "}
      <code className="font-mono">t=&lt;timestamp&gt;,v1=&lt;hex_hmac&gt;</code> over{" "}
      <code className="font-mono">&lt;timestamp&gt;.&lt;body&gt;</code>. Reject if |now−t| exceeds
      300s; use a timing-safe compare.
    </p>
  );
}

export function StepDots({
  step,
  created,
  pending,
  onGoToStep,
}: {
  step: 1 | 2 | 3 | 4;
  created: boolean;
  pending: boolean;
  onGoToStep: (n: 1 | 2 | 3 | 4) => void;
}) {
  const labels = ["Source", "Destination (optional)", "Review", "Activate"];
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="Wizard progress">
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3 | 4;
        const active = step === n;
        const done = step > n;
        const future = !active && !done;
        // Completed steps are clickable to jump back, but only while the
        // pipeline hasn't been created and no action is in flight — once a
        // source exists this session, re-editing earlier steps could
        // re-submit / desync the one-shot-secret flow. Forward jumps are
        // never allowed (the dot for a future step stays a static span).
        const dotClass = `grid size-5 place-items-center rounded-full text-[10px] font-semibold ${
          active
            ? "bg-primary text-primary-foreground"
            : done
            ? "bg-emerald-600 text-white"
            : "bg-muted text-muted-foreground"
        }`;
        const dotContent = done ? <CheckCircle2 className="size-3" /> : n;
        return (
          <li key={label} className="flex items-center gap-2">
            {done && !created && !pending ? (
              <button
                type="button"
                className={`${dotClass} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
                aria-label={`Go back to ${label} step`}
                onClick={() => onGoToStep(n)}
              >
                {dotContent}
              </button>
            ) : (
              <span
                className={dotClass}
                title={future ? "Complete the current step first" : undefined}
              >
                {dotContent}
              </span>
            )}
            <span
              className={active ? "text-foreground" : ""}
              aria-current={active ? "step" : undefined}
            >
              {label}
            </span>
            {i < labels.length - 1 ? <span className="opacity-50">·</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Explainer of what happens when the source is created. Webhook sources
 * only see traffic that arrives at the ingest URL after creation — there's
 * nothing to backfill server-side. (For already-recorded ClickHouse events,
 * the route detail page has a separate "Replay window" backfill control.)
 */
export function SyncBehaviorNotice({ provider }: { provider: SourceProvider }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs">
      <p className="font-medium text-foreground">Captures events going forward.</p>
      <p className="mt-0.5 leading-5 text-muted-foreground">
        {"Webhook sources start receiving events the moment you create them — there's no historical record to backfill. " +
          `After creation, point ${sourceProviderLabel(provider)} at the clean ingest URL Axel returns. ` +
          sourceAuthenticationCopy(provider) +
          " Your consumer should verify the X-Axel-Signature header (HMAC-SHA256, format t=<timestamp>,v1=<hex>) on each delivery."}
      </p>
    </div>
  );
}

export function ModeRadio({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-accent/40"
      }`}
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

export function InboundProviderFields({
  value,
  onValueChange,
}: {
  value?: SourceProvider;
  onValueChange?: (provider: SourceProvider) => void;
} = {}) {
  // AXE-23 — provider preset for inbound HMAC verification.
  // Lives client-side so the signing-secret input can show/hide based
  // on the picked provider without a round-trip.
  const [localProvider, setLocalProvider] = useState<SourceProvider>("custom");
  const provider = value ?? localProvider;

  function selectProvider(nextValue: string) {
    const nextProvider = nextValue as SourceProvider;
    if (value === undefined) setLocalProvider(nextProvider);
    onValueChange?.(nextProvider);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="pipeline-inbound-provider">Inbound provider</Label>
      <Select
        name="inbound_provider"
        value={provider}
        onValueChange={selectProvider}
      >
        <SelectTrigger id="pipeline-inbound-provider" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="custom">Custom / other service (token auth)</SelectItem>
          <SelectItem value="stripe">Stripe (Stripe-Signature header)</SelectItem>
          <SelectItem value="github">GitHub (X-Hub-Signature-256 header)</SelectItem>
          <SelectItem value="shopify">Shopify (X-Shopify-Hmac-Sha256 header)</SelectItem>
          <SelectItem value="chargebee">Chargebee (HTTP Basic Auth)</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Choosing a named provider enables its native webhook authentication. Axel rejects requests
        that do not verify. Leave this set to Custom for token-authenticated requests.
      </p>
      {provider !== "custom" ? (
        <div className="space-y-1.5 rounded-md border border-input bg-muted/30 p-3">
          <Label htmlFor="pipeline-inbound-secret" className="text-xs">
            {provider === "stripe"
              ? "Stripe webhook signing secret (whsec_…)"
              : provider === "github"
              ? "GitHub webhook secret (choose any string — you will enter this same value in GitHub)"
              : provider === "chargebee"
              ? "Chargebee webhook Basic Auth (not your login)"
              : "Shopify webhook secret — shared secret from Shopify Admin → Settings → Notifications → Webhooks (legacy) or Partners dashboard → App setup → Webhooks (Custom App)"}
          </Label>
          <Input
            id="pipeline-inbound-secret"
            name="inbound_signing_secret"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === "stripe" ? "whsec_..." : provider === "chargebee" ? "username:password" : "•••••••••••••••"}
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted at rest — never exposed in logs or API responses. The ingest worker
            decrypts it at the edge to verify each inbound payload before R2 / queue writes — invalid
            signatures are rejected with a non-billable 401.
            {provider === "stripe" ? (
              <> See{" "}
                <a
                  className="underline hover:text-foreground"
                  href="https://dashboard.stripe.com/webhooks"
                  target="_blank"
                  rel="noreferrer"
                >
                  dashboard.stripe.com/webhooks
                </a>{" "}
                → your endpoint → "Reveal" to find this value.
              </>
            ) : null}
            {provider === "github" ? (
              <> Choose a Secret value (any string), enter it here, then click Create pipeline. You
                will receive your Ingest URL on the next screen — go back to GitHub and paste it as
                the Payload URL when adding the webhook (repo → Settings → Webhooks → Add webhook for
                a repo; org → Settings → Webhooks for an org). See{" "}
                <a
                  className="underline hover:text-foreground"
                  href="https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub docs
                </a>
                .
              </>
            ) : null}
            {provider === "shopify" ? (
              <> See{" "}
                <a
                  className="underline hover:text-foreground"
                  href="https://shopify.dev/docs/apps/webhooks/configuration/https#step-5-verify-the-webhook"
                  target="_blank"
                  rel="noreferrer"
                >
                  Shopify webhook verification docs
                </a>{" "}
                for where to find or set the shared secret.
              </>
            ) : null}
            {provider === "shopify" ? (
              <> Configure delivery in your{" "}
                <a
                  className="underline hover:text-foreground"
                  href="https://help.shopify.com/en/manual/orders/notifications/webhooks"
                  target="_blank"
                  rel="noreferrer"
                >
                  Shopify webhook settings
                </a>
                .
              </>
            ) : null}
            {provider === "chargebee" ? (
              <> In Chargebee: Settings → Webhooks → your webhook → Basic Authentication. Chargebee
                generates a username and password for webhook verification — enter them as
                username:password. This is NOT your Chargebee login. See{" "}
                <a
                  className="underline hover:text-foreground"
                  href="https://www.chargebee.com/docs/2.0/webhook_settings.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Chargebee webhook settings
                </a>
                .
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
