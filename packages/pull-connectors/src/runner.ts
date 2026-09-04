import type {
  PullConnector,
  PullRecordSink,
  PullRunOptions,
  PullRunSummary,
  PullSource,
  PullSourceState,
  PullStateStore,
  PullStream,
  PullStreamConfig,
  PullStreamState,
  PullStreamSummary,
} from "./types";
import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";

export async function runPullSync<TConfig>(
  input: {
    source: PullSource<TConfig>;
    connector: PullConnector<TConfig>;
    stateStore: PullStateStore;
    sink: PullRecordSink;
  },
  options: PullRunOptions = {},
): Promise<PullRunSummary> {
  if (input.connector.type !== input.source.type) {
    throw new Error(`connector/source type mismatch: ${input.connector.type} cannot run ${input.source.type}`);
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const persistedState = await input.stateStore.get(input.source.source_id);
  const selected = selectStreams(input.connector.streams(input.source.config), input.source.config, options.streams);
  const summaries: PullStreamSummary[] = [];

  for (const { stream, config } of selected) {
    if (options.signal?.aborted) throw new Error("pull sync aborted");
    try {
      const runInput: Parameters<typeof runStream<TConfig>>[0] = {
        source: input.source,
        stream,
        config,
        persistedState,
        stateStore: input.stateStore,
        sink: input.sink,
        now,
        maxPages: options.maxPagesPerStream ?? 1_000,
        maxRecords: options.maxRecordsPerStream ?? Number.POSITIVE_INFINITY,
      };
      if (options.signal) runInput.signal = options.signal;
      const summary = await runStream(runInput);
      summaries.push(summary);
    } catch (err) {
      summaries.push({
        stream: safeStreamName(stream.name),
        records: 0,
        pages: 0,
        cursor: persistedState?.streams[stream.name]?.cursor ?? null,
        status: "failed",
        error: safePullDiagnostic(err),
      });
    }
  }

  return {
    source_id: input.source.source_id,
    source_type: input.source.type,
    started_at: startedAt,
    finished_at: now().toISOString(),
    streams: summaries,
  };
}

async function runStream<TConfig>(input: {
  source: PullSource<TConfig>;
  stream: PullStream<TConfig>;
  config: PullStreamConfig;
  persistedState: PullSourceState | null;
  stateStore: PullStateStore;
  sink: PullRecordSink;
  now: () => Date;
  maxPages: number;
  maxRecords: number;
  signal?: AbortSignal;
}): Promise<PullStreamSummary> {
  let pages = 0;
  let records = 0;
  const priorState = input.persistedState?.streams[input.stream.name] ?? null;
  // The committed cursor floor for THIS run (the connector's `> cursor` window).
  // It stays fixed across the run and across mid-pageset resumes — only a clean
  // drain advances it (see the per-page checkpoint note below).
  const baseCursor = priorState?.cursor ?? null;
  // A capped/crashed prior run may already have seen the global maximum on an
  // earlier (newer) page. Carry it forward separately from the committed cursor
  // so the eventual clean drain commits the whole pageset's maximum.
  let highWatermark = maxCursor(baseCursor, priorState?.pendingHighWatermark ?? null);
  // Resume an interrupted pageset from the last persisted page token instead of
  // restarting pagination. Restarting is silently lossy for descending streams.
  let pageCursor: string | undefined = priorState?.resumePageCursor ?? undefined;
  let drained = false;

  while (pages < input.maxPages && records < input.maxRecords) {
    if (input.signal?.aborted) throw new Error("pull sync aborted");

    const readInput: Parameters<PullStream<TConfig>["read"]>[0] = {
      source: input.source,
      stream: input.config,
      state: priorState,
      now: input.now,
    };
    if (pageCursor) readInput.pageCursor = pageCursor;
    if (input.signal) readInput.signal = input.signal;
    const page = await input.stream.read(readInput);
    pages += 1;

    // Treat maxRecords as a page-boundary cap. Opaque API page tokens cannot
    // resume halfway through a page: stopping mid-page and saving nextCursor
    // drops the unread tail, while saving the current token replays that page
    // forever when its size is larger than the cap. Finishing the page may
    // exceed maxRecords by at most one page, but preserves forward progress and
    // every record.
    for (const record of page.records) {
      await input.sink.write(record);
      records += 1;
    }

    highWatermark = maxCursor(highWatermark, page.highWatermark);
    // Checkpoint after each fully-written non-terminal page so a mid-stream
    // failure (caught in runPullSync) resumes from HERE rather than re-pulling
    // the whole stream.
    // Crucially we persist the resume PAGE token, not an advanced cursor: the
    // committed `cursor` stays pinned at the run's base until the stream fully
    // drains. Advancing it per-page is silently lossy for descending streams
    // (Stripe lists are newest-first) — page 1 carries the global-max cursor, so
    // committing it would make the next run's `> cursor` filter skip every older,
    // never-fetched page. Under-committing may re-deliver rows; over-committing
    // drops data. Preserve the pending maximum so the final run does not regress
    // to its older page's watermark. Do not write a terminal
    // `resumePageCursor: null` checkpoint:
    // finalization below commits cursor + clears continuation atomically in one
    // state-store write.
    if (!page.nextCursor) {
      drained = true;
      break;
    }
    await input.stateStore.setStreamState(input.source.source_id, input.stream.name, {
      cursor: baseCursor,
      resumePageCursor: page.nextCursor,
      pendingHighWatermark: highWatermark,
      updated_at: input.now().toISOString(),
    });
    pageCursor = page.nextCursor;
  }

  if (!drained) {
    // A safety cap is a resumable, non-success outcome. The last full-page
    // checkpoint (or the untouched prior state when the cap is zero) already
    // pins the committed cursor at baseCursor and retains the correct page
    // token, so the next run cannot skip unread pages. In particular, do not
    // fall through to the clean-drain finalizer below.
    const hitRecordsCap = records >= input.maxRecords;
    return {
      stream: safeStreamName(input.stream.name),
      records,
      pages,
      cursor: baseCursor,
      status: "partial",
      error: hitRecordsCap ? "max_records_per_stream_reached" : "max_pages_per_stream_reached",
    };
  }

  const nextState: PullStreamState = {
    // Stream fully drained — now it is safe to advance the committed cursor to
    // the high-watermark and clear the resume token.
    cursor: highWatermark,
    resumePageCursor: null,
    pendingHighWatermark: null,
    updated_at: input.now().toISOString(),
  };
  // Final write also covers the zero-page case (loop body never ran).
  await input.stateStore.setStreamState(input.source.source_id, input.stream.name, nextState);

  return {
    stream: safeStreamName(input.stream.name),
    records,
    pages,
    cursor: nextState.cursor,
    status: "success",
  };
}

function selectStreams<TConfig>(
  available: PullStream<TConfig>[],
  config: TConfig,
  explicit?: string[],
): Array<{ stream: PullStream<TConfig>; config: PullStreamConfig }> {
  const configured = readConfiguredStreams(config);
  const byName = new Map(available.map((stream) => [stream.name, stream]));
  const names = explicit ?? configured.filter((stream) => stream.selected !== false).map((stream) => stream.name);
  const fallbackNames = names.length > 0 ? names : available.map((stream) => stream.name);

  return fallbackNames.map((name) => {
    const stream = byName.get(name);
    if (!stream) throw new Error("unknown pull stream configured");
    return {
      stream,
      config: configured.find((item) => item.name === name) ?? {
        name,
        sync_mode: "incremental",
        cursor_field: stream.defaultCursorField,
        selected: true,
      },
    };
  });
}

/**
 * Persistence-safe pull summary. Cursor values originate in customer records
 * and can themselves be PII or secrets, so the diagnostic copy records only
 * whether a cursor exists. Live cursor state remains in pull_source_stream_state.
 */
export function sanitizePullRunSummaryForStorage(summary: PullRunSummary): Record<string, unknown> {
  return {
    started_at: summary.started_at,
    finished_at: summary.finished_at,
    streams: summary.streams.slice(0, 100).map((stream) => ({
      stream: safeStoredStreamName(summary.source_type, stream.stream),
      records: stream.records,
      pages: stream.pages,
      cursor_present: stream.cursor !== null,
      status: stream.status,
      ...(stream.error ? { error: safePullDiagnostic(stream.error) } : {}),
    })),
  };
}

function safeStreamName(value: string): string {
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9_.-]{0,159}$/iu.test(trimmed)
    ? trimmed
    : "pull_stream";
}

const SAFE_STORED_STREAMS_BY_SOURCE = new Map<string, ReadonlySet<string>>([
  ["chargebee", new Set(["customers", "subscriptions", "invoices"])],
  ["shopify", new Set(["customers", "orders", "products"])],
  [
    "stripe",
    new Set(["customers", "subscriptions", "invoices", "payment_intents"]),
  ],
]);

function safeStoredStreamName(sourceType: string, value: string): string {
  const safeName = safeStreamName(value);
  return SAFE_STORED_STREAMS_BY_SOURCE.get(sourceType)?.has(safeName)
    ? safeName
    : "pull_stream";
}

function safePullDiagnostic(value: unknown): string {
  return sanitizeConnectorDiagnosticForStorage(
    value instanceof Error ? value.message : value,
    500,
  ) || "pull_stream_failed";
}

function readConfiguredStreams(config: unknown): PullStreamConfig[] {
  if (!config || typeof config !== "object" || !("streams" in config)) return [];
  const streams = (config as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return [];
  return streams.filter(isPullStreamConfig);
}

function isPullStreamConfig(value: unknown): value is PullStreamConfig {
  return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

function maxCursor(left: PullStreamState["cursor"], right: PullStreamState["cursor"]): PullStreamState["cursor"] {
  if (!left) return right;
  if (!right) return left;
  const leftNum = Number(left.value);
  const rightNum = Number(right.value);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    return rightNum > leftNum ? right : left;
  }
  return String(right.value) > String(left.value) ? right : left;
}

export class InMemoryPullStateStore implements PullStateStore {
  readonly states = new Map<string, PullSourceState>();

  async get(sourceId: string): Promise<PullSourceState | null> {
    return this.states.get(sourceId) ?? null;
  }

  async setStreamState(sourceId: string, streamName: string, state: PullStreamState): Promise<void> {
    const existing = this.states.get(sourceId) ?? { streams: {} };
    existing.streams[streamName] = state;
    this.states.set(sourceId, existing);
  }
}

export class InMemoryPullRecordSink implements PullRecordSink {
  readonly records: import("./types").PullRecord[] = [];

  async write(record: import("./types").PullRecord): Promise<void> {
    this.records.push(record);
  }
}
