"use client";

import { useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "../../../../_components/CopyButton";
import { useToast } from "../../../../../_components/Toast";

/**
 * "Send this event again" panel on the event detail page (AXE-53).
 *
 * Two output modes — both are copy-paste, no surprises:
 *   - **cURL**: a one-liner the operator can paste into Postman /
 *     iTerm / a teammate's chat. Reproduces the exact bytes Axel
 *     received.
 *   - **axel CLI**: the same `axel replay` command our CLI ships.
 *
 * We deliberately don't try to POST from the browser to localhost —
 * cross-origin preflights to a random local server fail more often
 * than they succeed and the error message leaves operators stuck.
 * The two snippets always work.
 */

interface Props {
  eventId: string;
  contentType: string;
  /** Headers Axel captured at ingest, lowercased keys. */
  headers: Record<string, string>;
  /** Raw bytes Axel persisted in R2, base64-encoded so the page can ship them as a string. */
  bodyBase64: string;
}

// Provider signature headers carry a timestamp; replaying them stale
// makes the receiver reject. Strip by default; let the operator opt
// back in via the toggle for the rare case they want to verify
// signature handling.
const SIGNATURE_HEADERS = new Set<string>([
  "stripe-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-shopify-hmac-sha256",
  "x-axel-signature",
]);

const STRIP_HEADERS = new Set<string>(["host", "content-length", "connection"]);

export function EventReplayPanel({ eventId, contentType, headers, bodyBase64 }: Props) {
  const [forwardTo, setForwardTo] = useState("http://localhost:3000/webhooks");
  const [keepSignature, setKeepSignature] = useState(false);

  const filteredHeaders = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lc = k.toLowerCase();
      if (STRIP_HEADERS.has(lc)) continue;
      if (!keepSignature && SIGNATURE_HEADERS.has(lc)) continue;
      out[k] = v;
    }
    out["content-type"] = contentType;
    out["x-axel-replay-event-id"] = eventId;
    return out;
  }, [headers, contentType, eventId, keepSignature]);

  const curl = useMemo(() => {
    return buildCurl(forwardTo, filteredHeaders, bodyBase64);
  }, [forwardTo, filteredHeaders, bodyBase64]);

  const cliCommand = useMemo(() => {
    const flags = keepSignature ? " --keep-signature" : "";
    return `axel replay ${eventId} --forward-to ${forwardTo}${flags}`;
  }, [eventId, forwardTo, keepSignature]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Re-send the exact bytes Axel received to your local handler. We don&apos;t POST from the
        browser (CORS preflights to localhost rarely cooperate), so copy one of the snippets
        below — both are equivalent.
      </p>

      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="replay-url" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Forward to
          </Label>
          <Input
            id="replay-url"
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
            placeholder="http://localhost:3000/webhooks"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
          />
        </div>
        <div className="flex items-end">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={keepSignature}
              onChange={(e) => setKeepSignature(e.target.checked)}
              className="size-3.5 rounded border-input"
            />
            keep signature header (stale ts)
          </label>
        </div>
      </div>

      <Snippet label="cURL" value={curl} icon={<Terminal className="size-4" />} />
      <Snippet label="Axel CLI" value={cliCommand} icon={<Terminal className="size-4" />} />
    </div>
  );
}

function Snippet({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  const toast = useToast();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </Label>
        <CopyButton
          value={value}
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          labelClassName="ml-1 text-xs"
          resetAfterMs={1200}
          onCopyError={() =>
            toast.error("Couldn't copy to the clipboard. Select the text and copy it manually.")
          }
        />
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
        {value}
      </pre>
    </div>
  );
}

/**
 * Compose a single-line curl command. Bash-quote the URL + each
 * header value with single quotes (escaping any single quote inside
 * by closing-the-quote, escaping it, re-opening). The body uses
 * `--data-binary @-` with a base64-decoded heredoc so binary payloads
 * survive intact.
 */
function buildCurl(url: string, headers: Record<string, string>, bodyBase64: string): string {
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `  -H ${shellQuote(`${k}: ${v}`)}`)
    .join(" \\\n");
  return [
    `# Pipes the original bytes Axel received into your endpoint.`,
    `# Decode + POST in one go so binary payloads survive.`,
    `printf %s ${shellQuote(bodyBase64)} | base64 -d | curl -sS -X POST ${shellQuote(url)} \\`,
    headerArgs,
    `  --data-binary @-`,
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
