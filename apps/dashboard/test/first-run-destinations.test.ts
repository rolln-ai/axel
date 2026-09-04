import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_DESTINATIONS,
  FIRST_RUN_TLS_NO_VERIFY_DEFAULT,
  deriveDestinationNameBase,
  firstRunDestination,
  parseDestinationUrl,
  uniqueDestinationName,
  validateDestinationTarget,
} from "../lib/first-run-destinations";
import { schemaFor } from "../lib/destination-defaults";
import { PIPELINE_BINDING_REQUIRED } from "../lib/pipeline-binding";
import { entityNameError } from "../lib/entity-name";

describe("FIRST_RUN_DESTINATIONS catalogue", () => {
  it("asks for every field its destination type requires", () => {
    // The whole point of the shortened form is dropping optional fields. Drop a
    // REQUIRED one and createDestinationWithCredential rejects the insert after
    // the user has filled everything in — so assert coverage here instead.
    for (const entry of FIRST_RUN_DESTINATIONS) {
      const schema = schemaFor(entry.type);
      const asked = new Set(entry.fields.map((f) => f.key));
      // webhook's signing_secret is optional in the schema and generated
      // server-side, so it is deliberately not asked for.
      const missing = schema.fields
        .filter((f) => f.required !== false && !asked.has(f.key))
        .map((f) => f.key);
      expect(missing, `${entry.type} is missing required fields`).toEqual([]);
    }
  });

  it("only asks for fields the destination type actually defines", () => {
    for (const entry of FIRST_RUN_DESTINATIONS) {
      const known = new Set(schemaFor(entry.type).fields.map((f) => f.key));
      for (const field of entry.fields) {
        expect(known.has(field.key), `${entry.type}.${field.key} is not in the schema`).toBe(true);
      }
    }
  });

  it("defines a target for exactly the types that need a binding", () => {
    // A binding-required type with no target field would create a route that
    // dead-letters every event; a target on a type that takes none is noise.
    for (const entry of FIRST_RUN_DESTINATIONS) {
      expect(
        Boolean(entry.target),
        `${entry.type} target presence should match PIPELINE_BINDING_REQUIRED`,
      ).toBe(PIPELINE_BINDING_REQUIRED.has(entry.type));
    }
  });

  it("collects the BigQuery dataset and table as separate, explicit inputs", () => {
    const target = firstRunDestination("bigquery")?.target;
    expect(target?.parts?.map((part) => part.key)).toEqual(["dataset", "table"]);
    expect(target?.separator).toBe(".");
    expect(target?.hint).toMatch(/no separate database/i);
  });

  it("covers the types a first-time user is most likely to want", () => {
    const types = FIRST_RUN_DESTINATIONS.map((d) => d.type);
    expect(types).toContain("postgres");
    expect(types).toContain("webhook");
    expect(new Set(types).size, "duplicate types in the catalogue").toBe(types.length);
  });

  it("offers the self-signed-certificate toggle on the database types", () => {
    // Private/self-hosted databases sometimes need this escape hatch; the
    // other destination types do not use a database TLS client here.
    const withToggle = FIRST_RUN_DESTINATIONS.filter((d) => d.tlsToggle).map((d) => d.type);
    expect(withToggle.sort()).toEqual(["mongodb", "postgres"]);
    expect(firstRunDestination("postgres")?.tlsToggle?.key).toBe("pg_ssl_no_verify");
    expect(firstRunDestination("mongodb")?.tlsToggle?.key).toBe("mongo_tls_no_verify");
  });

  it("keeps certificate identity verification enabled by default", () => {
    expect(FIRST_RUN_TLS_NO_VERIFY_DEFAULT).toBe(false);
  });

  it("names the toggle's field so the delivery path actually reads it", () => {
    // The server appends `dest_field_` and the probe looks for these exact
    // keys — a typo here silently does nothing.
    for (const entry of FIRST_RUN_DESTINATIONS) {
      if (!entry.tlsToggle) continue;
      expect(["pg_ssl_no_verify", "mongo_tls_no_verify"]).toContain(entry.tlsToggle.key);
    }
  });

  it("looks up by type and returns undefined for anything else", () => {
    expect(firstRunDestination("postgres")?.label).toBe("Postgres");
    expect(firstRunDestination("databricks_sql")).toBeUndefined();
    expect(firstRunDestination("nonsense")).toBeUndefined();
  });
});

describe("deriveDestinationNameBase", () => {
  it("names each type from what the user typed", () => {
    expect(
      deriveDestinationNameBase("webhook", { url: "https://api.example.com/hooks" }),
    ).toBe("api.example.com");
    expect(deriveDestinationNameBase("s3", { bucket: "my-events" })).toBe("my-events");
    expect(deriveDestinationNameBase("mongodb", { database: "axel_events" })).toBe("axel_events");
    expect(deriveDestinationNameBase("bigquery", { project_id: "analytics-prod" })).toBe(
      "analytics-prod",
    );
    expect(
      deriveDestinationNameBase("postgres", {
        connection_string: "postgresql://user:pass@db.example.com:5432/app",
      }),
    ).toBe("db.example.com");
  });

  it("never leaks credentials from a Postgres DSN into the name", () => {
    const name = deriveDestinationNameBase("postgres", {
      connection_string: "postgresql://admin:sup3rs3cret@db.example.com:5432/app",
    });
    expect(name).not.toContain("sup3rs3cret");
    expect(name).not.toContain("admin");
  });

  it("falls back to the type label when the value can't be a display name", () => {
    expect(deriveDestinationNameBase("postgres", { connection_string: "not a url" })).toBe(
      "Postgres",
    );
    expect(deriveDestinationNameBase("webhook", { url: "" })).toBe("HTTP endpoint");
    // Bracketed IPv6 literals aren't valid display names.
    expect(deriveDestinationNameBase("webhook", { url: "https://[::1]:9000/x" })).toBe(
      "HTTP endpoint",
    );
  });

  it("always produces a name the entity-name validator accepts", () => {
    const cases: Array<[Parameters<typeof deriveDestinationNameBase>[0], Record<string, string>]> = [
      ["webhook", { url: "https://api.example.com/x" }],
      ["webhook", { url: "https://[::1]:9000/x" }],
      ["postgres", { connection_string: "postgresql://u:p@10.0.0.5:5432/db" }],
      ["postgres", { connection_string: "" }],
      ["s3", { bucket: "" }],
      ["mongodb", { database: "" }],
      ["bigquery", { project_id: "" }],
    ];
    for (const [type, values] of cases) {
      const name = deriveDestinationNameBase(type, values);
      expect(entityNameError(name), `${type} -> ${name}`).toBeNull();
    }
  });
});

describe("uniqueDestinationName", () => {
  it("returns the base when it's free", () => {
    expect(uniqueDestinationName("Postgres", new Set())).toBe("Postgres");
  });

  it("suffixes past every taken name, case-insensitively", () => {
    const taken = new Set(["postgres", "postgres 2"]);
    const result = uniqueDestinationName("Postgres", taken);
    expect(result).toBe("Postgres 3");
    expect(entityNameError(result)).toBeNull();
  });
});

describe("validateDestinationTarget", () => {
  it("rejects the hyphenated Postgres table that dead-lettered in production", () => {
    // `test-5` saved fine and then failed EVERY delivery with
    // `unsafe column identifier: "test-5"` — invisible to the user.
    const error = validateDestinationTarget("postgres", "test-5");
    expect(error).toMatch(/letters, numbers, and underscores/i);
    // The message should offer the corrected name.
    expect(error).toContain("test_5");
  });

  it("accepts ordinary Postgres tables, including schema-qualified", () => {
    for (const target of ["events", "axel_events", "app.events", "Events2"]) {
      expect(validateDestinationTarget("postgres", target), target).toBeNull();
    }
  });

  it("rejects Postgres targets the delivery path can't quote", () => {
    for (const target of ["my table", "events;drop", "a.b.c", 'ev"il']) {
      expect(validateDestinationTarget("postgres", target), target).not.toBeNull();
    }
  });

  it("mirrors quotePgIdent — anything it accepts, the delivery path accepts", () => {
    // quotePgIdent: /^[A-Za-z0-9_][A-Za-z0-9_.]*$/ per part.
    const pgIdent = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;
    for (const target of ["events", "app.events", "test-5", "my table", "_x", "9lives"]) {
      const accepted = validateDestinationTarget("postgres", target) === null;
      if (accepted) {
        for (const part of target.split(".")) {
          expect(pgIdent.test(part), `${target} part ${part}`).toBe(true);
        }
      }
    }
  });

  it("enforces BigQuery dataset.table", () => {
    expect(validateDestinationTarget("bigquery", "analytics.events")).toBeNull();
    // Hyphens are legal in a BQ table but not a dataset.
    expect(validateDestinationTarget("bigquery", "analytics.event-stream")).toBeNull();
    expect(validateDestinationTarget("bigquery", "events")).toMatch(/dataset\.table/i);
    expect(validateDestinationTarget("bigquery", ".events")).toMatch(/dataset id is required/i);
    expect(validateDestinationTarget("bigquery", "analytics.")).toMatch(/table id is required/i);
    expect(validateDestinationTarget("bigquery", "my-dataset.events")).toMatch(/dataset/i);
  });

  it("enforces MongoDB collection rules", () => {
    expect(validateDestinationTarget("mongodb", "events")).toBeNull();
    expect(validateDestinationTarget("mongodb", "my-events")).toBeNull();
    expect(validateDestinationTarget("mongodb", "ev$ents")).toMatch(/\$/);
    expect(validateDestinationTarget("mongodb", "system.users")).toMatch(/reserved/i);
  });

  it("requires a target for types that need one, and ignores those that don't", () => {
    expect(validateDestinationTarget("postgres", "  ")).toMatch(/required/i);
    // S3 and HTTP take no binding.
    expect(validateDestinationTarget("s3", "")).toBeNull();
    expect(validateDestinationTarget("webhook", "")).toBeNull();
  });
});

describe("parseDestinationUrl", () => {
  it("accepts http and https", () => {
    expect("url" in parseDestinationUrl("https://api.example.com/hooks")).toBe(true);
    expect("url" in parseDestinationUrl("http://localhost:3000/in")).toBe(true);
  });

  it("rejects blank, schemeless, and non-http URLs", () => {
    for (const raw of ["  ", "api.example.com/hooks", "ftp://example.com", "javascript:alert(1)"]) {
      expect("error" in parseDestinationUrl(raw), raw).toBe(true);
    }
  });
});
