"use client";

/**
 * Shared clipboard primitives. Previously four near-identical copy buttons
 * (the old shared chip, SecretCopy in ApiKeysPanel, CopyableSecret in
 * PersonalAccessTokensPanel, and a local CopyButton in CreateDestinationForm)
 * plus three raw `navigator.clipboard.writeText` call sites had drifted apart;
 * this module is the single source of truth for all of them.
 *
 * - `useCopyToClipboard` — copy + transient "Copied" state. Falls back to the
 *   legacy execCommand path in non-secure contexts (http://) where the async
 *   Clipboard API is unavailable; calls `onError` when copying fails.
 * - `CopyButton` — the button. `variant="chip"` renders the original tiny
 *   bordered chip; "ghost"/"outline" render a shadcn <Button>.
 * - `CopyableSecret` — code-plus-copy-button row for one-shot secrets. Always
 *   toasts on failure: the secret is shown exactly once, so a silent copy
 *   failure means a permanently lost secret.
 */
import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "../../_components/Toast";

export function useCopyToClipboard({
  resetAfterMs = 1500,
  onError,
}: {
  /** How long the "Copied" feedback shows. */
  resetAfterMs?: number;
  /** Called when copying fails. Silent when omitted. */
  onError?: () => void;
} = {}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (value: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          // Fallback for non-secure contexts (http://) where the async
          // Clipboard API is unavailable: stage the value in a hidden
          // textarea and use the legacy execCommand copy path.
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), resetAfterMs);
      } catch {
        onError?.();
      }
    },
    [resetAfterMs, onError],
  );
  return { copied, copy };
}

interface CopyButtonProps {
  value: string;
  /** Visible label. Icon-only buttons (size="icon") use it as the aria-label. */
  label?: string;
  /**
   * "chip" renders the original tiny bordered chip button; "ghost" and
   * "outline" render a shadcn <Button> of that variant.
   */
  variant?: "chip" | "ghost" | "outline";
  size?: "xs" | "sm" | "icon";
  /** Extra classes for the underlying button (non-chip variants). */
  className?: string;
  /** When set, wraps the label in a <span> with these classes (e.g. "ml-1"). */
  labelClassName?: string;
  /** How long the "Copied" feedback shows. */
  resetAfterMs?: number;
  /** Called when copying fails. Silent when omitted. */
  onCopyError?: () => void;
}

export function CopyButton({
  value,
  label = "Copy",
  variant = "chip",
  size = "xs",
  className,
  labelClassName,
  resetAfterMs = 1500,
  onCopyError,
}: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard({ resetAfterMs, onError: onCopyError });

  if (variant === "chip") {
    const padding = size === "sm" ? "px-2 py-1" : "px-1.5 py-0.5";
    const text = size === "sm" ? "text-xs" : "text-[10px]";
    return (
      <button
        type="button"
        className={`inline-flex items-center gap-1 rounded border border-border bg-background ${padding} ${text} text-muted-foreground transition-colors hover:bg-muted hover:text-foreground`}
        onClick={() => copy(value)}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : label}
      </button>
    );
  }

  if (size === "icon") {
    return (
      <Button
        type="button"
        variant={variant}
        size="icon"
        className={className}
        aria-label={copied ? "Copied" : label}
        onClick={() => copy(value)}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    );
  }

  const labelText = copied ? "Copied" : label;
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={className}
      onClick={() => copy(value)}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {labelClassName ? <span className={labelClassName}>{labelText}</span> : labelText}
    </Button>
  );
}

export function CopyableSecret({
  value,
  noun = "value",
  appearance = "field",
}: {
  value: string;
  /** Noun used in the copy-failure toast ("key", "token", …). */
  noun?: string;
  /**
   * "panel" — borderless row on bg-background with a labelled outline button
   * (the API-key reveal panel); "field" — bordered input-like row with an
   * icon-only button (personal access tokens).
   */
  appearance?: "panel" | "field";
}) {
  const toast = useToast();
  // The secret is shown exactly once — a silent copy failure means a
  // permanently lost secret. Tell the user to copy it by hand.
  const onCopyError = () =>
    toast.error(`Couldn't copy to the clipboard. Select the ${noun} text and copy it manually.`);

  if (appearance === "panel") {
    return (
      <div className="flex items-center gap-2 rounded bg-background p-2">
        <code className="flex-1 truncate font-mono text-xs">{value}</code>
        <CopyButton
          value={value}
          variant="outline"
          size="sm"
          labelClassName="ml-1"
          onCopyError={onCopyError}
        />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <CopyButton
        value={value}
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        resetAfterMs={1200}
        onCopyError={onCopyError}
      />
    </div>
  );
}
