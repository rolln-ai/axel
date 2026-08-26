import { installNodeSentryHandlers, type CaptureContext } from "../../src/index.ts";

const mode = process.argv[2] ?? "uncaught";
let captureCount = 0;

const client = {
  async captureException(error: unknown, context?: CaptureContext) {
    captureCount += 1;
    process.stdout.write(`CAPTURE ${JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      kind: context?.tags?.kind,
    })}\n`);
    if (mode === "timeout") {
      await new Promise<void>(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  },
  async captureMessage() {},
  async captureTransaction() {},
  async captureCheckIn() {
    return "check-in";
  },
};

const options = { flushTimeoutMs: mode === "timeout" ? 40 : 500 };
installNodeSentryHandlers(client, options);
if (mode === "duplicate") {
  // Regression guard for frameworks that invoke instrumentation registration
  // more than once in the same process.
  installNodeSentryHandlers(client, options);
}

process.on("exit", (code) => {
  process.stdout.write(`EXIT ${code} CAPTURES ${captureCount}\n`);
});

// Prevent a broken handler from making the regression test hang forever.
const watchdog = setTimeout(() => process.exit(2), 1_000);
watchdog.unref();

switch (mode) {
  case "uncaught":
    setTimeout(() => {
      throw new Error("uncaught-probe");
    }, 0);
    break;
  case "rejection":
    void Promise.reject(new Error("rejection-probe"));
    break;
  case "timeout":
    setTimeout(() => {
      throw new Error("timeout-probe");
    }, 0);
    break;
  case "duplicate":
    setTimeout(() => {
      process.emit("uncaughtException", new Error("first-probe"));
      process.emit("unhandledRejection", new Error("second-probe"), Promise.resolve());
    }, 0);
    break;
  default:
    throw new Error(`unknown fixture mode: ${mode}`);
}
