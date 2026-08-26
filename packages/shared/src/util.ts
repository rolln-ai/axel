/**
 * Small cross-runtime helpers shared by the Node services (delivery-service,
 * pull-worker) and the library packages consumed from Cloudflare Workers
 * (router, delivery-worker, router-edge). Everything here is dependency-free
 * and uses Web APIs only, so it behaves identically in both runtimes — these
 * used to be copy-pasted per app and had started to drift.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copy a Uint8Array into a standalone ArrayBuffer (no shared backing store). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * Bounded-concurrency async map.
 *
 * A plain `Promise.all(items.map(...))` is unbounded: a batch of N messages
 * opens N concurrent deliveries (each holding a credential lookup, an
 * idempotency claim, and an outbound socket) regardless of any configured
 * `maxConcurrentMessages`. At the platform's target throughput that lets one
 * slow/large batch saturate the DB pool and the destination. This caps the
 * number of in-flight `fn` calls at `concurrency` while still draining every
 * item, and preserves input order in the returned array.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  fn: (input: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (inputs.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const out = new Array<TOutput>(inputs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= inputs.length) return;
      out[index] = await fn(inputs[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return out;
}

/**
 * Read a required env var or throw. Takes the env record explicitly (pass
 * `process.env` in Node) so this module never references `process` — it must
 * stay loadable in Cloudflare Workers without nodejs_compat.
 *
 * Note: delivery-service keeps its own boot-time variant that logs and
 * `process.exit(1)`s instead of throwing — that difference is deliberate.
 */
export function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

/** Parse an integer env var, falling back when unset or not a finite number. */
export function numericEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
