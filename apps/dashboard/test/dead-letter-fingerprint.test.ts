import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deadLetterFingerprint, normaliseDeadLetterMessage } from "@axel/shared";

/**
 * The dead-letter fingerprint is the key operators mute against
 * (dead_letter_mutes.fingerprint) AND the value every dead_letters writer now
 * stamps on the row so bulk replay can skip muted fingerprints in SQL. If the
 * formula ever drifts, existing mutes silently stop matching and muted backlogs
 * get re-replayed. These tests LOCK the formula and prove the Web-Crypto
 * implementation is byte-identical to the original node:crypto one (so mutes
 * created before the column existed keep matching).
 */

// Reference: the exact original inbox.ts formula, recomputed with node:crypto.
function referenceFingerprint(route_id: string | null, reason: string, message: string): string {
  const slug = normaliseDeadLetterMessage(message).slice(0, 80);
  return createHash("sha256")
    .update(`${route_id ?? ""}|${reason}|${slug}`)
    .digest("hex")
    .slice(0, 16);
}

describe("deadLetterFingerprint", () => {
  it("matches pinned regression vectors (formula must not drift)", async () => {
    expect(await deadLetterFingerprint({ route_id: "rt_1", reason: "filter_invalid", message: "boom" })).toBe(
      "ee0f754a80e0b40b",
    );
    expect(await deadLetterFingerprint({ route_id: "rt_1", reason: "r", message: "café 日本語 🚀" })).toBe(
      "22e1078099e09275",
    );
  });

  it("is byte-identical to the node:crypto sha256 formula (Web Crypto parity)", async () => {
    const cases: Array<[string | null, string, string]> = [
      ["rt_1", "filter_invalid", "boom"],
      [null, "router_processing_failed", "delivery_service_503: overloaded"],
      ["rt_9", "delivery_dead_http", "café 日本語 🚀 — NFD́ vs NFC"],
      ["rt_1", "x", "  leading/trailing  whitespace  "],
    ];
    for (const [route_id, reason, message] of cases) {
      expect(await deadLetterFingerprint({ route_id, reason, message })).toBe(
        referenceFingerprint(route_id, reason, message),
      );
    }
  });

  it("treats a null route_id and an empty-string route_id identically", async () => {
    const withNull = await deadLetterFingerprint({ route_id: null, reason: "x", message: "y" });
    const withEmpty = await deadLetterFingerprint({ route_id: "", reason: "x", message: "y" });
    expect(withNull).toBe(withEmpty);
    expect(withNull).toBe("cb073433301037e0");
  });

  it("collapses per-event noise (timestamps, uuids, bare numbers) to one fingerprint", async () => {
    const concrete = await deadLetterFingerprint({
      route_id: "rt_1",
      reason: "delivery_dead_http",
      message: "failed at 2026-05-02T12:00:00.000Z id 12345 abc",
    });
    const templated = await deadLetterFingerprint({
      route_id: "rt_1",
      reason: "delivery_dead_http",
      message: "failed at <ts> id <n> abc",
    });
    expect(concrete).toBe(templated);
  });

  it("produces distinct fingerprints when a real detail changes", async () => {
    const base = await deadLetterFingerprint({ route_id: "rt_1", reason: "a", message: "m" });
    expect(await deadLetterFingerprint({ route_id: "rt_2", reason: "a", message: "m" })).not.toBe(base);
    expect(await deadLetterFingerprint({ route_id: "rt_1", reason: "b", message: "m" })).not.toBe(base);
    expect(await deadLetterFingerprint({ route_id: "rt_1", reason: "a", message: "different" })).not.toBe(base);
  });
});
