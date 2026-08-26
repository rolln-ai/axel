import { describe, expect, it } from "vitest";
import { dataTypeRepairFor } from "../lib/dead-letter-repair";

describe("dataTypeRepairFor", () => {
  it("turns a permanent decimal-to-integer failure into a route repair", () => {
    const repair = dataTypeRepairFor({
      reason: "delivery_dead",
      message: '{"insertErrors":[{"message":"Cannot convert value to integer (bad value): 5.69"}]}',
      routeId: "rt_1",
    });
    expect(repair?.title).toMatch(/Decimal value/);
    expect(repair?.detail).toMatch(/Retrying unchanged data will fail again/);
    expect(repair?.detail).toMatch(/FLOAT64/);
    expect(repair?.href).toBe("/routes/rt_1?repair=field-type");
  });

  it("turns bool-to-string failures into a target-or-transform choice", () => {
    const repair = dataTypeRepairFor({
      reason: "delivery_dead",
      message: "Conversion from bool to std::string is unsupported.",
      routeId: "rt_2",
    });
    expect(repair?.detail).toMatch(/BOOL/);
    expect(repair?.detail).toMatch(/Text \(STRING\)/);
  });

  it("turns array-to-scalar failures into a field-shape repair", () => {
    const repair = dataTypeRepairFor({
      reason: "delivery_dead",
      message: 'Array specified for non-repeated field: tags',
      routeId: "rt_3",
    });
    expect(repair).toMatchObject({
      kind: "field_shape",
      title: "Array value does not fit a scalar column",
      href: "/routes/rt_3?repair=field-shape",
    });
    expect(repair?.detail).toMatch(/incoming tags field is an array/);
    expect(repair?.detail).toMatch(/Collapse arrays to text/);
  });

  it("shows the exact field for human-readable BigQuery diagnostics", () => {
    const repair = dataTypeRepairFor({
      reason: "delivery_dead",
      message: 'BigQuery type mismatch at "data.properties.value": Axel sends INT64, but the target column is STRING. Retrying unchanged data will fail again. Change the target column to INT64, or convert "data.properties.value" to Text (STRING) before delivery.',
      routeId: "rt_4",
    });
    expect(repair).toMatchObject({
      kind: "field_type",
      title: "Convert data.properties.value to text",
      actionLabel: "Fix data",
      href: "/routes/rt_4?repair=field-type",
    });
    expect(repair?.detail).toMatch(/confirm the fix here/);
  });

  it("leaves transient and unrelated failures retryable", () => {
    expect(
      dataTypeRepairFor({ reason: "delivery_dead", message: "backendError", routeId: "rt_1" }),
    ).toBeNull();
    expect(
      dataTypeRepairFor({ reason: "delivery_retry", message: "Cannot convert value to integer" }),
    ).toBeNull();
  });
});
