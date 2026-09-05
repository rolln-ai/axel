import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reports idle router liveness even when a recent batch used the heartbeat throttle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 204 }));
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as ExecutionContext;
  const env = {
    DELIVERY_SERVICE_URL: "https://delivery.example/",
    DELIVERY_SHARED_SECRET: "synthetic-heartbeat-secret",
    SENTRY_ENVIRONMENT: "test",
  } as Parameters<typeof worker.scheduled>[1];

  await worker.queue({ messages: [], queue: "axel-events-00" } as Parameters<typeof worker.queue>[0], env, ctx);
  await Promise.all(pending);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // A cron tick can land just after a batch in the same isolate. It must
  // still report liveness, then keep doing so without another queue call.
  vi.setSystemTime(new Date("2026-09-05T12:00:10Z"));
  await worker.scheduled({} as ScheduledController, env, ctx);
  vi.setSystemTime(new Date("2026-09-05T12:02:10Z"));
  await worker.scheduled({} as ScheduledController, env, ctx);
  await Promise.all(pending);

  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [url, request] = fetchMock.mock.calls[2]!;
  expect(url).toBe("https://delivery.example/internal/heartbeat");
  expect(request).toMatchObject({
    method: "POST",
    redirect: "manual",
    headers: { "x-axel-shared-secret": "synthetic-heartbeat-secret" },
  });
  expect(JSON.parse(request!.body as string)).toMatchObject({
    component: "router-edge",
    environment: "test",
    expectedIntervalSeconds: 180,
    tickCount: 3,
  });
});
