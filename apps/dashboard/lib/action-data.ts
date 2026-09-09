import type { ActionState as ActionStateBase } from "./action-state";

/**
 * Structured data the actions in this module surface alongside the
 * human-readable `notice`. Used for things the UI needs to render
 * differently (e.g. a brand-new ingest token rendered in a copy block
 * separate from the prose so it doesn't get accidentally selected with
 * surrounding text).
 */
export interface ActionData {
  sourceId?: string;
  plaintextToken?: string;
  /** One-shot URL credential. Never persisted in plaintext or returned on reads. */
  plaintextUrlToken?: string;
  urlTokenEnabled?: boolean;
  ingestUrl?: string;
  /** Set on webhook-destination creation when Axel generated the secret. Shown once. */
  webhookSigningSecret?: string;
  /** Set together with webhookSigningSecret so the UI can deep-link to the new dest. */
  destinationId?: string;
  /** Set by connectFirstDestination so first-run setup can link to the route. */
  routeId?: string;
  /** Set when connecting queued a backfill of events received pre-route. */
  backfillJobId?: string;
  /** ClickHouse estimate of that backfill's size, for immediate feedback. */
  backfillEstimated?: number;
  /**
   * AXE-25 — the real event_id minted by ingest for a sent test event.
   * The Send-test-event dialog polls getTestEventOutcome() with this id to
   * surface the actual routing + delivery outcome instead of a mock.
   */
  eventId?: string;
}

export type ActionState = ActionStateBase<ActionData>;
