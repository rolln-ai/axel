"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { updateSourceFieldSelection } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import {
  formatFieldSelectionText,
  parseFieldSelectionText,
  projectPayload,
} from "../../../../lib/field-selection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function FieldSelectionEditor({
  sourceId,
  initialPaths,
  samplePayload,
}: {
  sourceId: string;
  initialPaths: string[] | null;
  samplePayload: unknown;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateSourceFieldSelection,
    {},
  );
  const [text, setText] = useState(() => formatFieldSelectionText(initialPaths));

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  const preview = useMemo(() => {
    const { paths, errors } = parseFieldSelectionText(text);
    if (errors.length > 0) {
      return { kind: "errors", errors } as const;
    }
    if (paths.length === 0) {
      return { kind: "passthrough" } as const;
    }
    if (samplePayload === null || samplePayload === undefined) {
      return { kind: "no-sample", paths } as const;
    }
    const projected = projectPayload(samplePayload, paths);
    return { kind: "projected", paths, projected } as const;
  }, [text, samplePayload]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="source_id" value={sourceId} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="selection_text">Allowed paths (one per line)</Label>
          <Textarea
            id="selection_text"
            name="selection_text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"# leave empty to pass through every field\ncustomer.email\namount\ndata.object.id"}
            spellCheck={false}
            rows={10}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Dot-paths into the JSON body. Lines starting with{" "}
            <code className="rounded-sm bg-muted px-1 font-mono">#</code> are comments. Empty selection = pass through.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Preview (most recent event projected)</Label>
          {preview.kind === "errors" ? (
            <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
              {preview.errors.map((e) => (
                <li key={e.line} className="text-destructive">
                  line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          ) : preview.kind === "passthrough" ? (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
              {"// pass-through — destinations get the full payload"}
            </pre>
          ) : preview.kind === "no-sample" ? (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
              {"// will project to: "}
              {preview.paths.join(", ")}
              {"\n// no recent events to preview against — send a webhook to see the projection."}
            </pre>
          ) : (
            <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(preview.projected, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save field selection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setText("")}
          disabled={pending}
        >
          Clear (pass-through)
        </Button>
      </div>
    </form>
  );
}
