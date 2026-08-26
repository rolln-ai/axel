import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConditionalDestField,
  type RenderableDestinationField,
} from "../app/(app)/destinations/ConditionalDestField";
import {
  CREATABLE_DESTINATION_SCHEMAS,
  type DestinationType,
} from "../lib/destination-defaults";
import { FIRST_RUN_DESTINATIONS } from "../lib/first-run-destinations";

/**
 * The submitted input NAME is load-bearing: the create/connect server actions
 * read `dest_field_<key>` (wizard + first-run) or the bare key (destination
 * create/edit forms). A renderer regression that changes a name makes the
 * action silently drop that piece of config — no error, just a destination
 * missing its credential. Lock the names down for every field of every
 * creatable schema, in each variant.
 */

function render(
  field: RenderableDestinationField,
  type: DestinationType,
  props: Record<string, unknown>,
): string {
  // A showWhen field only renders when its controlling value matches; feed it
  // exactly that value so every conditional field is exercised too.
  const fieldValues = field.showWhen ? { [field.showWhen.field]: field.showWhen.equals } : {};
  return renderToStaticMarkup(
    createElement(ConditionalDestField, {
      field,
      type,
      fieldValues,
      setFieldValue: () => {},
      ...props,
    }),
  );
}

describe("ConditionalDestField submitted input names", () => {
  it("wizard variant renders name=dest_field_<key> for every creatable-schema field", () => {
    for (const schema of CREATABLE_DESTINATION_SCHEMAS) {
      for (const field of schema.fields) {
        const html = render(field, schema.type, {
          variant: "wizard",
          namePrefix: "dest_field_",
          idPrefix: "pipeline-dest-",
        });
        expect(html, `${schema.type}.${field.key} (wizard)`).toContain(
          `name="dest_field_${field.key}"`,
        );
        expect(html, `${schema.type}.${field.key} (wizard id)`).toContain(
          `id="pipeline-dest-${field.key}"`,
        );
        // The wizard must never emit native `required` — it would block the
        // "Just create source" skip path behind hidden invalid fields.
        expect(html, `${schema.type}.${field.key} (wizard required)`).not.toContain('required=""');
      }
    }
  });

  it("first-run variant renders name=dest_field_<key> for every first-run field", () => {
    for (const spec of FIRST_RUN_DESTINATIONS) {
      for (const field of spec.fields) {
        const html = render(field, spec.type, {
          variant: "first-run",
          namePrefix: "dest_field_",
          idPrefix: "fr-dest-",
        });
        expect(html, `${spec.type}.${field.key} (first-run)`).toContain(
          `name="dest_field_${field.key}"`,
        );
        expect(html, `${spec.type}.${field.key} (first-run id)`).toContain(
          `id="fr-dest-${field.key}"`,
        );
        // First-run gates its submit button on completeness instead of native
        // validation, and deliberately renders `url` fields as plain text.
        expect(html, `${spec.type}.${field.key} (first-run required)`).not.toContain('required=""');
        if (field.inputType === "url") {
          expect(html, `${spec.type}.${field.key} (first-run url→text)`).toContain('type="text"');
        }
      }
    }
  });

  it("form variant (create/edit forms) renders the bare field key as the name", () => {
    for (const schema of CREATABLE_DESTINATION_SCHEMAS) {
      for (const field of schema.fields) {
        // Radix Select's form bridge doesn't materialize in static SSR markup;
        // the select fields' names are covered by the wizard hidden-input case.
        if (field.inputType === "select") continue;
        const html = render(field, schema.type, {});
        expect(html, `${schema.type}.${field.key} (form)`).toContain(`name="${field.key}"`);
        expect(html, `${schema.type}.${field.key} (form id)`).toContain(`id="dest-${field.key}"`);
      }
    }
  });

  it("hides a showWhen field whose controlling value does not match", () => {
    for (const schema of CREATABLE_DESTINATION_SCHEMAS) {
      for (const field of schema.fields) {
        if (!field.showWhen) continue;
        const html = renderToStaticMarkup(
          createElement(ConditionalDestField, {
            field,
            type: schema.type,
            fieldValues: { [field.showWhen.field]: `${field.showWhen.equals}-no-match` },
            setFieldValue: () => {},
            variant: "wizard",
            namePrefix: "dest_field_",
          }),
        );
        expect(html, `${schema.type}.${field.key} should be hidden`).toBe("");
      }
    }
  });
});
