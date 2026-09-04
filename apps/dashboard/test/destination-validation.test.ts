import { describe, expect, it } from "vitest";
import {
  isCreatableDestinationType,
  readDestinationValues,
  validateDestinationType,
  validateDestinationValues,
} from "../lib/destination-validation";

/**
 * Shared destination validation (lib/destination-validation.ts) — the single
 * copy behind createDestination/updateDestination AND the test-destination
 * probes. The probe module used to carry a hand-mirrored copy that had lost
 * the SSRF host check and the whitespace rejection; these tests pin the
 * unified behaviour.
 */

describe("validateDestinationType / isCreatableDestinationType", () => {
  it("accepts every creatable type on both predicates", () => {
    for (const type of ["webhook", "http", "mongodb", "postgres", "s3", "r2", "databricks_volume", "bigquery"]) {
      expect(validateDestinationType(type)).toBe(true);
      expect(isCreatableDestinationType(type)).toBe(true);
    }
  });

  it("accepts legacy databricks_sql for probe/edit but not for create", () => {
    // availableForCreate: false — existing rows must stay testable/editable,
    // but the create form must not mint new ones.
    expect(validateDestinationType("databricks_sql")).toBe(true);
    expect(isCreatableDestinationType("databricks_sql")).toBe(false);
  });

  it("rejects unknown types on both predicates", () => {
    expect(validateDestinationType("kafka")).toBe(false);
    expect(isCreatableDestinationType("kafka")).toBe(false);
  });
});

describe("readDestinationValues", () => {
  it("keeps schema fields RAW and drops everything else", () => {
    const fd = new FormData();
    fd.set("connection_string", " postgres://u:p@db.example.com/db ");
    fd.set("csrf_token", "nope");
    fd.set("type", "postgres");
    const values = readDestinationValues(fd, "postgres");
    expect(values).toEqual({ connection_string: " postgres://u:p@db.example.com/db " });
  });

  it("reads prefixed fields for the pipeline wizard", () => {
    const fd = new FormData();
    fd.set("dest_field_database", "events");
    fd.set("dest_field_connection_string", "mongodb://u:p@cluster.example.com/");
    const values = readDestinationValues(fd, "mongodb", { prefix: "dest_field_" });
    expect(values).toEqual({
      database: "events",
      connection_string: "mongodb://u:p@cluster.example.com/",
    });
  });
});

describe("validateDestinationValues", () => {
  it("rejects outer whitespace on single-line secrets", () => {
    const error = validateDestinationValues("postgres", {
      connection_string: "postgres://u:p@db.example.com/db ",
    });
    expect(error).toMatch(/leading or trailing whitespace/);
  });

  it("rejects whitespace inside the user:password segment", () => {
    const error = validateDestinationValues("postgres", {
      connection_string: "postgres://user: password@db.example.com/db",
    });
    expect(error).toMatch(/whitespace inside the user:password segment/);
  });

  it("rejects a connection string pointing at a private/metadata host (SSRF)", () => {
    const error = validateDestinationValues("postgres", {
      connection_string: "postgres://u:p@169.254.169.254/db",
    });
    expect(error).not.toBeNull();
  });

  it("does not reflect a blocked URL or connection host", () => {
    const webhookError = validateDestinationValues("webhook", {
      url: "https://marker-secret.localhost/hook",
    });
    const postgresError = validateDestinationValues("postgres", {
      connection_string: "postgres://u:p@marker-secret.localhost/db",
    });

    expect(webhookError).toMatch(/outbound network policy/i);
    expect(postgresError).toMatch(/outbound network policy/i);
    expect(webhookError).not.toContain("marker-secret");
    expect(postgresError).not.toContain("marker-secret");
  });

  it("rejects a connection string with no scheme or no @host", () => {
    expect(
      validateDestinationValues("postgres", { connection_string: "db.example.com:5432" }),
    ).toMatch(/doesn't look like a URL/);
    expect(
      validateDestinationValues("postgres", { connection_string: "postgres://db.example.com/db" }),
    ).toMatch(/missing the "@host" portion/);
  });

  it("trims textarea secrets in place instead of rejecting them", () => {
    const values = {
      project_id: "my-project",
      service_account_json: '  {"type":"service_account"}\n',
    };
    expect(validateDestinationValues("bigquery", values)).toBeNull();
    expect(values.service_account_json).toBe('{"type":"service_account"}');
  });

  it("accepts a clean public connection string", () => {
    expect(
      validateDestinationValues("postgres", {
        connection_string: "postgres://user:pass@db.example.com:5432/app",
      }),
    ).toBeNull();
  });
});
