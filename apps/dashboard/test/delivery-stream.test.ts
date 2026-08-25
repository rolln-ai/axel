import { describe, expect, it } from "vitest";
import type { DeliveryStreamRow } from "../app/(app)/deliveries/DeliveryStreamTable";
import {
  clickhouseStatusForFilter,
  countActiveDeliveryFilters,
  failedDeliveriesPath,
  filterDeliveryRows,
  notificationLinkPath,
  parseDeliveryFilters,
} from "../lib/delivery-stream";

function row(over: Partial<DeliveryStreamRow> = {}): DeliveryStreamRow {
  return {
    id: "attempt:att_1",
    kind: "attempt",
    event_id: "evt_1",
    source_id: "src_1",
    route_id: "rte_1",
    destination_id: "dst_1",
    destination_name: "Warehouse",
    destination_type: "bigquery",
    status: "success",
    status_at: "2026-08-25T12:00:00.000Z",
    attempt_no: 1,
    latency_ms: 20,
    response: {},
    dead_letter: null,
    ...over,
  };
}

describe("parseDeliveryFilters", () => {
  it("treats status=failed and the legacy status=dead alias as Failed", () => {
    expect(parseDeliveryFilters({ status: "failed" }).status).toBe("failed");
    expect(parseDeliveryFilters({ status: "dead" }).status).toBe("failed");
    expect(parseDeliveryFilters({ status: "success" }).status).toBe("success");
    expect(parseDeliveryFilters({ status: "nope" }).status).toBe("all");
  });

  it("drops the form's source=all / destination=all placeholders", () => {
    const filters = parseDeliveryFilters({
      source: "all",
      destination: "all",
      q: "  ",
    });
    expect(filters.source).toBe("");
    expect(filters.destination).toBe("");
    expect(filters.q).toBe("");
    expect(countActiveDeliveryFilters(filters)).toBe(0);
  });
});

describe("clickhouseStatusForFilter", () => {
  it("queries ClickHouse for dead attempts when the UI filter is Failed", () => {
    expect(clickhouseStatusForFilter("failed")).toBe("dead");
    expect(clickhouseStatusForFilter("success")).toBe("success");
    expect(clickhouseStatusForFilter("retry")).toBe("retry");
    expect(clickhouseStatusForFilter("all")).toBeNull();
  });
});

describe("filterDeliveryRows", () => {
  it("keeps terminal failures and unresolved dead-letter rows under Failed", () => {
    const rows = [
      row({ id: "a", status: "success" }),
      row({ id: "b", status: "retry" }),
      row({ id: "c", status: "dead", dead_letter: { id: "dl_1", reason: "http 500", message: "boom", replay: null } }),
      row({
        id: "d",
        kind: "dead_letter",
        status: "dead",
        destination_id: null,
        dead_letter: { id: "dl_2", reason: "max_retries_exceeded", message: null, replay: null },
      }),
    ];
    const filtered = filterDeliveryRows(rows, parseDeliveryFilters({ status: "failed" }));
    expect(filtered.map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("does not treat a success attempt as Failed just because a dead letter is attached", () => {
    const rows = [
      row({
        status: "success",
        dead_letter: { id: "dl_1", reason: "http 500", message: null, replay: null },
      }),
    ];
    expect(filterDeliveryRows(rows, parseDeliveryFilters({ status: "failed" }))).toEqual([]);
  });
});

describe("failedDeliveriesPath", () => {
  it("stamps status=failed onto a bare deliveries path", () => {
    expect(failedDeliveriesPath("/deliveries")).toBe("/deliveries?status=failed");
    expect(failedDeliveriesPath(null)).toBe("/deliveries?status=failed");
  });

  it("preserves a workspace handoff prefix and existing query params", () => {
    expect(failedDeliveriesPath("/workspaces/ws_1/deliveries")).toBe(
      "/workspaces/ws_1/deliveries?status=failed",
    );
    expect(failedDeliveriesPath("/deliveries?q=timeout")).toBe(
      "/deliveries?q=timeout&status=failed",
    );
  });

  it("does not rewrite a per-delivery investigate URL", () => {
    expect(failedDeliveriesPath("/deliveries/dl_1/investigate")).toBe(
      "/deliveries/dl_1/investigate",
    );
  });
});

describe("notificationLinkPath", () => {
  it("rewrites a legacy replay-complete CTA onto the failed stream", () => {
    expect(
      notificationLinkPath(
        "replay_job_complete",
        "Replay finished: 0 succeeded, 100 still failing",
        "/deliveries",
      ),
    ).toBe("/deliveries?status=failed");
  });

  it("leaves successful replay and unrelated notifications alone", () => {
    expect(
      notificationLinkPath("replay_job_complete", "Replay finished: 40 succeeded", "/deliveries"),
    ).toBe("/deliveries");
    expect(notificationLinkPath("data_contract_drift", "Field type changed", "/data-contracts/em_1")).toBe(
      "/data-contracts/em_1",
    );
  });
});
