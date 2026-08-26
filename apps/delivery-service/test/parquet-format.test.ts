import { describe, expect, it } from "vitest";
import {
  writeParquetBuffer,
  readParquetRows,
  mergeParquetBuffers,
  type S3ParquetRow,
} from "../src/connectors/parquet-format.ts";

function row(id: string, payload: unknown): S3ParquetRow {
  return {
    event_id: id,
    workspace_id: "ws-1",
    source_id: "src-1",
    route_id: "rt-1",
    destination_id: "dst-1",
    received_at: "2026-06-18T12:00:00.000Z",
    written_at: "2026-06-18T12:00:01.000Z",
    payload_json: JSON.stringify(payload),
  };
}

const META = { batchId: "b1", workspaceId: "ws-1", routeId: "rt-1", destinationId: "dst-1" };

describe("parquet-format round trip", () => {
  it("writes then reads back the same rows", async () => {
    const rows = [row("e1", { a: 1 }), row("e2", { a: 2 })];
    const buf = await writeParquetBuffer(rows, META);
    expect(buf.subarray(0, 4).toString("utf8")).toBe("PAR1");

    const out = await readParquetRows(buf);
    expect(out).toHaveLength(2);
    expect(out[0]?.event_id).toBe("e1");
    expect(out[0]?.payload_json).toBe(JSON.stringify({ a: 1 }));
    expect(out[1]?.event_id).toBe("e2");
    // Timestamp columns round-trip as ISO-8601 strings.
    expect(out[0]?.received_at).toBe("2026-06-18T12:00:00.000Z");
  });

  it("merges several files into one preserving every row in order", async () => {
    const a = await writeParquetBuffer([row("a1", { n: 1 }), row("a2", { n: 2 })], META);
    const b = await writeParquetBuffer([row("b1", { n: 3 })], META);
    const c = await writeParquetBuffer([row("c1", { n: 4 }), row("c2", { n: 5 })], META);

    const { buffer, rowCount } = await mergeParquetBuffers([a, b, c], {
      ...META,
      batchId: "merged",
    });
    expect(rowCount).toBe(5);

    const out = await readParquetRows(buffer);
    expect(out.map((r) => r.event_id)).toEqual(["a1", "a2", "b1", "c1", "c2"]);
    expect(out.map((r) => JSON.parse(r.payload_json).n)).toEqual([1, 2, 3, 4, 5]);
  });
});
