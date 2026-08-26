"use client";

import * as React from "react";
import { useActionState, useEffect, useState } from "react";
import { Play, AlertCircle, CheckCircle, Sparkles } from "lucide-react";
import { sendTestEvent } from "../../../../lib/test-event-actions";
import type { ActionState } from "../../../../lib/action-data";
import { useTestEventPoll, Inspector } from "./TestEventRunner";
import { TEST_PAYLOADS } from "../../../../lib/test-payloads";
import {
  getSyntheticPayloadsForSourceAction,
  type SyntheticPayloadsResponse,
} from "../../../../lib/data-contracts/synth-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

/**
 * AXE-25: Send test event dialog with mock payloads + a LIVE inspector.
 *
 * The send goes through the real ingest path flagged is_test, so it routes
 * and delivers exactly like a real event. After a successful send we poll
 * getTestEventOutcome() to surface the REAL routing/delivery result —
 * which routes matched, what each destination returned — instead of
 * fabricating success. A pipeline with zero routes or a broken destination
 * now shows up clearly here, before go-live.
 */
interface Props {
  sourceId: string;
  sourceName: string;
  ingestUrl: string;
  canMutate: boolean;
}

export function SendTestEventDialog({ sourceId, sourceName, ingestUrl, canMutate }: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(sendTestEvent, {});
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof TEST_PAYLOADS>("generic");
  const [customJson, setCustomJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [dataContract, setDataContract] = useState<SyntheticPayloadsResponse | null>(null);
  // Send + outcome-poll logic is shared with the first-run wizard activation
  // step; see TestEventRunner. This drives the same Inspector off our state.
  const { inspector, reset } = useTestEventPoll(state);

  useEffect(() => {
    // Fetch synthetic payloads from the source's active Data Contract. If
    // there isn't one (or no clusters yet), the bar just doesn't render
    // — the operator falls back to the canned presets.
    let cancelled = false;
    getSyntheticPayloadsForSourceAction(sourceId)
      .then((res) => {
        if (!cancelled) setDataContract(res);
      })
      .catch(() => {
        /* network blip — silently fall back to canned presets */
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const currentPayload = React.useMemo(() => {
    if (customJson.trim()) {
      try {
        return JSON.parse(customJson);
      } catch {
        return TEST_PAYLOADS[selectedPreset]?.payload;
      }
    }
    return TEST_PAYLOADS[selectedPreset]?.payload;
  }, [selectedPreset, customJson]);

  useEffect(() => {
    // Validate JSON live
    if (customJson.trim()) {
      try {
        JSON.parse(customJson);
        setJsonError(null);
      } catch (e) {
        setJsonError((e as Error).message);
      }
    } else {
      setJsonError(null);
    }
  }, [customJson]);

  const handlePreset = (key: keyof typeof TEST_PAYLOADS) => {
    setSelectedPreset(key);
    setCustomJson(JSON.stringify(TEST_PAYLOADS[key]?.payload, null, 2));
  };

  if (!canMutate) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Play className="h-4 w-4" />
          Send test event
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Send test event — {sourceName}</DialogTitle>
          <DialogDescription>
            Send a sample payload through the real ingest path (marked as test). Results appear in event history with "Test" badge.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="source_id" value={sourceId} />
          <input type="hidden" name="payload" value={JSON.stringify(currentPayload)} />

          {dataContract?.available && dataContract.options.length > 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-foreground">
                <Sparkles className="size-3.5" />
                Generate from {dataContract.data_contract_name}
              </div>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Click an event type to pre-fill the editor with a synthetic
                payload matching that cluster's schema. Edit before sending.
              </p>
              <div className="flex flex-wrap gap-2">
                {dataContract.options.map((option) => (
                  <button
                    key={option.cluster_id}
                    type="button"
                    onClick={() => {
                      setCustomJson(JSON.stringify(option.payload, null, 2));
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground hover:bg-muted"
                  >
                    <span className="truncate">{option.cluster_name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      ({option.sample_count})
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <Label className="text-sm font-medium">Payload template</Label>
            <Tabs defaultValue="generic" className="mt-2">
              <TabsList className="grid grid-cols-3 lg:grid-cols-7">
                {Object.keys(TEST_PAYLOADS).map((k) => (
                  <TabsTrigger
                    key={k}
                    value={k}
                    onClick={() => handlePreset(k as keyof typeof TEST_PAYLOADS)}
                  >
                    {TEST_PAYLOADS[k]?.label.split(" ")[0]}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value={selectedPreset} className="mt-3">
                <Textarea
                  value={customJson || JSON.stringify(TEST_PAYLOADS[selectedPreset]?.payload, null, 2)}
                  onChange={(e) => setCustomJson(e.target.value)}
                  className="font-mono text-xs h-48"
                  placeholder="Edit JSON here for custom payload..."
                />
                {jsonError && (
                  <p className="mt-1 text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {jsonError}
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !!jsonError} className="gap-2">
              <Play className="h-4 w-4" />
              {pending ? "Sending via ingest..." : "Send test event"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCustomJson("");
                reset();
              }}
            >
              Reset
            </Button>
          </div>

          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          {state.notice && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription className="font-mono text-xs">{state.notice}</AlertDescription>
            </Alert>
          )}

          {inspector.phase !== "idle" && (
            <Inspector sourceId={sourceId} inspector={inspector} />
          )}
        </form>

        <p className="text-[10px] text-muted-foreground">
          Sends to {ingestUrl} (test traffic, flagged is_test — excluded from usage metrics). Invalid JSON blocked client-side.
        </p>
      </DialogContent>
    </Dialog>
  );
}
