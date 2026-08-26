"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import {
  createPersonalAccessToken,
  revokePersonalAccessToken,
  type ActionState,
  type PatRow,
} from "../../../lib/pat-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyableSecret } from "../_components/CopyButton";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { LocalTime } from "../../_components/LocalTime";
import { buildCliAuthLoginHint } from "../../../lib/cli-command";

interface Props {
  initialTokens: PatRow[];
  apiBaseUrl: string;
}

export function PersonalAccessTokensPanel({ initialTokens, apiBaseUrl }: Props) {
  const [createState, createAction, creating] = useActionState<ActionState, FormData>(
    createPersonalAccessToken,
    {},
  );
  const [revokeState, revokeAction, revoking] = useActionState<ActionState, FormData>(
    revokePersonalAccessToken,
    {},
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Personal access tokens authenticate the{" "}
        <code className="font-mono text-xs">@axel/cli</code> against your workspace. Each token is
        scoped to (you, this workspace) — revoking your workspace membership revokes all your tokens
        too.
      </p>

      {/* ---------- CREATE ---------- */}
      <form action={createAction} className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
        <Label htmlFor="pat-name" className="text-sm font-semibold text-foreground">
          Mint a new token
        </Label>
        <div className="flex gap-2">
          <Input
            id="pat-name"
            name="name"
            placeholder="laptop, ci, devbox…"
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={creating}>
            {creating ? "Minting…" : "Mint"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The plaintext token is shown only once. After that, lose it = rotate it.
        </p>

        {createState.error ? (
          <Alert variant="destructive">
            <AlertDescription>{createState.error}</AlertDescription>
          </Alert>
        ) : null}

        {createState.notice && createState.data?.plaintextToken ? (
          <Alert>
            <AlertDescription className="space-y-2">
              <span className="block">{createState.notice}</span>
              <CopyableSecret value={createState.data.plaintextToken} noun="token" />
              <CliHint apiBaseUrl={apiBaseUrl} />
            </AlertDescription>
          </Alert>
        ) : null}
      </form>

      {revokeState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{revokeState.error}</AlertDescription>
        </Alert>
      ) : null}
      {revokeState.notice ? (
        <Alert>
          <AlertDescription>{revokeState.notice}</AlertDescription>
        </Alert>
      ) : null}

      {/* ---------- LIST ---------- */}
      <div className="rounded-lg border border-border">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Name</div>
          <div>Created</div>
          <div>Last used</div>
          <div>Status</div>
          <div />
        </div>
        {initialTokens.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No tokens yet. Mint one above to use the Axel CLI.
          </div>
        ) : (
          initialTokens.map((tok) => (
            <div
              key={tok.id}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0"
            >
              <div className="min-w-0">
                <strong className="block truncate text-foreground">{tok.name}</strong>
                <code className="font-mono text-[11px] text-muted-foreground">{tok.id}</code>
              </div>
              <small className="text-xs text-muted-foreground">
                <LocalTime value={tok.created_at} />
              </small>
              <small className="text-xs text-muted-foreground">
                {tok.last_used_at ? <LocalTime value={tok.last_used_at} /> : "—"}
              </small>
              <Badge variant={tok.revoked_at ? "secondary" : "default"} className="capitalize">
                {tok.revoked_at ? "revoked" : "active"}
              </Badge>
              {tok.revoked_at ? (
                <span />
              ) : (
                <form action={revokeAction}>
                  <input type="hidden" name="token_id" value={tok.id} />
                  <ConfirmAction
                    title="Revoke token"
                    body="Revoke this token? Anything using it stops working immediately."
                    confirmLabel="Revoke"
                    destructive
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${tok.name}`}
                      disabled={revoking}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </ConfirmAction>
                </form>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CliHint({ apiBaseUrl }: { apiBaseUrl: string }) {
  return (
    <pre className="mt-1 overflow-x-auto rounded-md bg-background p-2 font-mono text-[11px] text-muted-foreground">
      {buildCliAuthLoginHint(apiBaseUrl)}
    </pre>
  );
}
