export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

const buckets = new Map<string, Bucket>();

export function checkTokenBucket(input: {
  key: string;
  limitPerMinute: number;
  nowMs?: number;
}): RateLimitResult {
  const limit = Math.max(1, Math.floor(input.limitPerMinute));
  const now = input.nowMs ?? Date.now();
  const refillPerMs = limit / 60_000;
  const existing = buckets.get(input.key) ?? { tokens: limit, updatedAtMs: now };
  const elapsed = Math.max(0, now - existing.updatedAtMs);
  const tokens = Math.min(limit, existing.tokens + elapsed * refillPerMs);

  if (tokens < 1) {
    buckets.set(input.key, { tokens, updatedAtMs: now });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)),
    };
  }

  buckets.set(input.key, { tokens: tokens - 1, updatedAtMs: now });
  return { allowed: true };
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
