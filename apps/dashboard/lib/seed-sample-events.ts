"use server";

import { resolveIngestBaseUrl } from "@axel/shared";
import { db } from "./db";
import { withWorkspaceMutation } from "./with-mutation";
import { TEST_PAYLOADS } from "./test-payloads";
import type { ActionState as ActionStateBase } from "./action-state";

/**
 * One-click "seed every sample payload into this source" action.
 * Pairs with the AXE-57 sample-payload expansion + the Data Contract
 * "Refresh now" affordance — operator clicks Seed, then Refresh,
 * and the map's event-type list jumps from 1 to 30+.
 *
 * Fires each payload through the ingest-worker `/admin/trigger-event`
 * endpoint (same path the AXE-26 `axel trigger` CLI uses), so the
 * events take the same R2 + queue path as a real production webhook
 * — they're just stamped `is_test=true` so they're visible in
 * inspectors but excluded from billing.
 */

export type ActionState = ActionStateBase<{ sent: number; failed: number }>;

export async function seedSampleEvents(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Seeding fires ~35 events through the ingest worker — a mutation. Apply the
  // shared owner/admin + active-workspace gates (this module used to check
  // only requireSession).
  return withWorkspaceMutation<ActionState>({}, async ({ workspaceId, audit }) => {
    const sourceId = String(formData.get("source_id") ?? "").trim();
    if (!sourceId) return { error: "source_id is required." };

    const sourceCheck = await db().query<{ id: string }>(
      "SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1",
      [sourceId, workspaceId],
    );
    if (!sourceCheck.rowCount) {
      return { error: "Source not found in this workspace." };
    }

    let ingestBase: string;
    try {
      ingestBase = resolveIngestBaseUrl(process.env);
    } catch {
      return { error: "Sample-event service is not configured." };
    }
    const adminToken = process.env.INGEST_ADMIN_TOKEN;
    if (!adminToken) {
      return {
        error: "Sample-event service is not configured.",
      };
    }

    const presets = Object.entries(TEST_PAYLOADS);
    const startedAt = Date.now();
    let sent = 0;
    let failed = 0;

    // Bounded parallelism: 6 concurrent inflight requests is plenty for
    // ~35 payloads and avoids hammering the ingest worker.
    const concurrency = 6;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < presets.length) {
          const idx = cursor++;
          const entry = presets[idx];
          if (!entry) continue;
          const [key, preset] = entry;
          try {
            const res = await fetch(`${ingestBase.replace(/\/$/, "")}/admin/trigger-event`, {
              method: "POST",
              redirect: "manual",
              headers: {
                "content-type": "application/json",
                "x-axel-admin-token": adminToken,
              },
              body: JSON.stringify({
                source_id: sourceId,
                body: preset.payload,
                headers: { "content-type": "application/json", "x-axel-seed-preset": key },
                content_type: "application/json",
                actor_kind: "dashboard_seed",
              }),
            });
            if (res.ok) sent += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
      }),
    );

    const took = Date.now() - startedAt;
    await audit({
      action: "source.seeded_sample_events",
      targetType: "source",
      targetId: sourceId,
      metadata: { sent, failed, took_ms: took, presets: presets.length },
    });

    if (sent === 0) {
      return {
        error: `Could not seed sample events. ${failed} requests failed. Check the ingest service and try again.`,
      };
    }
    const failureNote = failed > 0 ? ` (${failed} failed)` : "";
    return {
      notice: `Seeded ${sent} sample events into the source in ${took}ms${failureNote}. Click "Refresh now" on the Data Contract to pick them up.`,
      data: { sent, failed },
    };
  });
}
