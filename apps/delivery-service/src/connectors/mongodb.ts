import { MongoClient, type Document } from "mongodb";
import type { Connector, DeliveryContext } from "@axel/connectors";
import { connectionHostSsrfReason, type Destination, type DeliveryAttempt, type MongoBinding } from "@axel/shared";
import { safeLookup } from "../safe-dns.js";

/**
 * MongoDB destination connector.
 *
 * Config shape:
 *   {
 *     "connection_string": "mongodb+srv://user:pass@cluster/db?retryWrites=true",
 *     "database": "events",
 *     "collection": "stripe_payments",
 *     "idempotency_field": "event_id"   // optional — upsert by this field
 *   }
 *
 * Insert is `insertOne(document)` by default. When `idempotency_field` is set
 * we use `updateOne({field: value}, {$setOnInsert: doc}, {upsert: true})` so
 * re-deliveries of the same event don't duplicate.
 */

interface MongoDestinationConfig {
  connection_string: string;
  database: string;
  /** Legacy / default — used when binding is missing. */
  collection?: string;
  /** Legacy / default — used when binding is missing. */
  idempotency_field?: string;
}

function resolveMongoBinding(
  binding: unknown,
  config: MongoDestinationConfig,
): MongoBinding | null {
  if (
    binding &&
    typeof binding === "object" &&
    "collection" in binding &&
    typeof (binding as MongoBinding).collection === "string"
  ) {
    return binding as MongoBinding;
  }
  if (config.collection) {
    return {
      collection: config.collection,
      ...(config.idempotency_field !== undefined ? { idempotency_field: config.idempotency_field } : {}),
    };
  }
  return null;
}

const clients = new Map<string, MongoClient>();

async function getClient(connectionString: string): Promise<MongoClient> {
  let client = clients.get(connectionString);
  if (!client) {
    client = new MongoClient(connectionString, {
      maxPoolSize: 4,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      lookup: safeLookup,
    });
    await client.connect();
    clients.set(connectionString, client);
  }
  return client;
}

function attemptOf(
  context: DeliveryContext | undefined,
  destination: Destination,
  status: DeliveryAttempt["status"],
  response: unknown,
  startedAt: number,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: context?.eventId ?? "unknown",
    destination_id: destination.destination_id,
    status,
    response,
    latency_ms: Date.now() - startedAt,
    created_at: new Date().toISOString(),
  };
}

export function createMongoConnector(): Connector<MongoDestinationConfig> {
  return {
    type: "mongodb",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;

      let document: Document;
      try {
        document = JSON.parse(new TextDecoder().decode(event)) as Document;
      } catch {
        document = { payload: new TextDecoder().decode(event) };
      }

      const binding = resolveMongoBinding(context?.binding, config);
      if (!binding) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "no collection binding configured for this route/destination" },
          startedAt,
        );
      }

      // Delivery-time SSRF guard: block a connection_string pointing at
      // loopback/link-local/private/metadata hosts before opening a socket
      // (defense in depth; save-time validates too). Permanent → dead-letter.
      const mongoSsrf = connectionHostSsrfReason(config.connection_string);
      if (mongoSsrf) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${mongoSsrf}` }, startedAt);
      }

      try {
        const client = await getClient(config.connection_string);
        const collection = client.db(config.database).collection(binding.collection);

        if (binding.idempotency_field) {
          const key = (document as Record<string, unknown>)[binding.idempotency_field];
          if (key === undefined) {
            return attemptOf(
              context,
              destination,
              "dead",
              { error: `idempotency_field '${binding.idempotency_field}' missing in payload` },
              startedAt,
            );
          }
          const result = await collection.updateOne(
            { [binding.idempotency_field]: key },
            { $setOnInsert: document },
            { upsert: true },
          );
          return attemptOf(
            context,
            destination,
            "success",
            { collection: binding.collection, matched: result.matchedCount, upserted: Boolean(result.upsertedId) },
            startedAt,
          );
        }

        const result = await collection.insertOne(document);
        return attemptOf(
          context,
          destination,
          "success",
          { collection: binding.collection, inserted_id: String(result.insertedId) },
          startedAt,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Permanent failures dead-letter (they never self-heal on retry):
        // document validation/bad-argument AND auth failures (wrong credentials).
        // Only transient connection/network errors stay retryable — auth was
        // previously retried forever and never surfaced an actionable dead letter.
        const permanent =
          /(validation|MongoBulkWriteError|MongoInvalidArgumentError|authentication\s*fail|not\s*authoriz|unauthorized|bad\s*auth|requires authentication)/i.test(
            message,
          );
        return attemptOf(
          context,
          destination,
          permanent ? "dead" : "retry",
          { error: message.slice(0, 500) },
          startedAt,
        );
      }
    },
  };
}

export async function closeAllMongoClients(): Promise<void> {
  for (const c of clients.values()) await c.close();
  clients.clear();
}
