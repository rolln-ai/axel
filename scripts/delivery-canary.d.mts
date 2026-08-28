export interface DeliveryCanaryOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  signal?: AbortSignal;
}

export interface DeliveryCanaryResult {
  probeId: string;
  eventId: string;
  latencyMs: number;
  receiptAttempts: number;
}

export function runDeliveryCanary(
  options?: DeliveryCanaryOptions,
): Promise<DeliveryCanaryResult>;
