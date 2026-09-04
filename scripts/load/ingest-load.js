// k6 load harness for the Axel ingest edge.
//
// The audit flagged that the "millions of webhooks per hour" target is
// unbenchmarked. 1M/hour ~= 278 accepted requests/second; this drives a target
// arrival rate against the public ingest endpoint and asserts the edge stays
// fast (p95) and almost never errors under sustained load. Run it after the
// Wave-5 changes (bounded delivery concurrency, autoscaling, route cache) to
// see whether the deliver path actually keeps up.
//
// Requires k6 (https://k6.io). This file is NOT part of the build/test/lint
// pipeline — it runs in the k6 runtime, not Node. See scripts/load/README.md.
//
// Usage:
//   k6 run -e INGEST_URL=https://ingest.axelapp.ai/in/<source_id> \
//          -e SOURCE_TOKEN=<token> -e RATE=300 -e DURATION=2m \
//          scripts/load/ingest-load.js

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const INGEST_URL = __ENV.INGEST_URL;
const SOURCE_TOKEN = __ENV.SOURCE_TOKEN || "";
// Target accepted requests/second. 278 rps ~= 1M/hour; default 300 (~1.08M/hr).
const RATE = Number(__ENV.RATE || 300);
const DURATION = __ENV.DURATION || "2m";

const accepted = new Counter("accepted_202");
const rejected = new Counter("rejected_non_202");

export const options = {
  scenarios: {
    sustained: {
      executor: "ramping-arrival-rate",
      startRate: Math.max(1, Math.floor(RATE / 10)),
      timeUnit: "1s",
      preAllocatedVUs: Math.max(50, RATE),
      maxVUs: Math.max(200, RATE * 4),
      stages: [
        { target: Math.floor(RATE / 2), duration: "30s" }, // warm up
        { target: RATE, duration: "30s" }, // ramp to target
        { target: RATE, duration: DURATION }, // hold at target
        { target: 0, duration: "20s" }, // ramp down
      ],
    },
  },
  thresholds: {
    // Ingest is an authentication check + R2 write + queue enqueue. It must stay
    // fast and almost never error to sustain the millions/hour target.
    http_req_failed: ["rate<0.01"], // <1% transport-level errors
    http_req_duration: ["p(95)<500", "p(99)<1500"],
    rejected_non_202: ["count<1"], // any non-202 is a real problem under load
  },
};

function buildUrl() {
  if (!INGEST_URL) {
    throw new Error(
      "INGEST_URL is required, e.g. -e INGEST_URL=https://ingest.axelapp.ai/in/<source_id>",
    );
  }
  if (/[?&]token(?:=|&|$)/i.test(INGEST_URL)) {
    throw new Error("INGEST_URL must not contain a source credential");
  }
  if (!SOURCE_TOKEN) {
    throw new Error("SOURCE_TOKEN is required for the dedicated custom load-test source");
  }
  return INGEST_URL;
}

export default function () {
  const payload = JSON.stringify({
    id: `load_${__VU}_${__ITER}`,
    type: "load.test",
    occurred_at: new Date().toISOString(),
    data: { vu: __VU, iter: __ITER, filler: "x".repeat(512) },
  });
  const headers = {
    "content-type": "application/json",
    "x-axel-token": SOURCE_TOKEN,
  };
  const res = http.post(buildUrl(), payload, { headers });
  check(res, { "status is 202": (r) => r.status === 202 });
  if (res.status === 202) {
    accepted.add(1);
  } else {
    rejected.add(1);
  }
}
