export const ROUTER_VERSION = "0.2.0-declarative";

export {
  handleBreach,
  inMemoryRouteStatusStore,
  inMemoryDeadLetterSink,
  type Breach,
  type BreachContext,
  type DeadLetterRecord,
  type DeadLetterSink,
  type RouteStatusStore,
} from "./breach.ts";
export {
  processQueueMessage,
  processQueueBatch,
  createInMemoryRouterDeps,
  type DeliveryQueueSink,
  type EventLogSink,
  type RawPayloadStore,
  type RouterDeps,
  type RouterProcessResult,
  type RouteStore,
  type RouteWithDestinationTypes,
} from "./processor.ts";
export {
  processReplayBatch,
  createInMemoryReplayStore,
  // The tagger whose output delivery-service parses back into a replay id.
  // Exported so the two can be round-trip tested together — they silently
  // drifted apart once (backfill `rpl_` ids vs a `rpy_`-only parser).
  replayEventId,
  replayPayloadKeyBelongsToWorkspace,
  type ReplayProcessorDeps,
  type ReplayProcessSummary,
  type ReplayRow,
  type ReplayStore,
  type ReplayPayloadHints,
} from "./replay.ts";
export {
  silentAlertSink,
  consoleAlertSink,
  multiAlertSink,
  webhookAlertSink,
  alertSinkFromEnv,
  externalAlertEvent,
  evaluateDeliveryHealth,
  evaluateDestinationLatency,
  evaluateQueueLag,
  evaluateEngineErrors,
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type AlertSeverity,
  type AlertSink,
  type AlertThresholds,
  type DeliveryWindowSnapshot,
  type DestinationLatencySnapshot,
  type QueueLagSnapshot,
  type EngineErrorSnapshot,
  type WebhookAlertSinkOptions,
} from "./alerts.ts";
export {
  startPeriodicRunner,
  type PeriodicJob,
  type RunnerHandle,
  type RunnerOptions,
  type JobStats,
} from "./runner.ts";
