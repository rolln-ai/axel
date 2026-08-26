"use client";

import {
  isDestinationFieldVisible,
  type DestinationField,
  type DestinationType,
} from "../../../lib/destination-defaults";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Structural subset of DestinationField accepted by the renderer, so the
 * first-run flow's shortened FirstRunField catalogue (which has no `kind`)
 * can flow through the same component as the full schemas.
 */
export interface RenderableDestinationField {
  key: string;
  label: string;
  hint?: string;
  kind?: DestinationField["kind"];
  inputType?: DestinationField["inputType"];
  options?: DestinationField["options"];
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  showWhen?: DestinationField["showWhen"];
}

/**
 * AXE-33 — single schema-driven field renderer with conditional visibility
 * and select-input support. Shared by every surface that collects
 * destination config:
 *
 *  - `variant="form"` (default) — the create dialog (CreateDestinationForm)
 *    and the destination Configuration tab (EditDestinationForm). Controlled
 *    inputs, native `required`, secret badges, names submitted as the bare
 *    field key.
 *  - `variant="wizard"` — the New Source wizard's destination step. Text
 *    inputs stay UNCONTROLLED (defaultValue + onChange mirror) — the wizard
 *    fights React 19's post-action form reset elsewhere and relies on the
 *    form's own DOM state across step transitions; do not convert these to
 *    controlled inputs. No native `required` (step-2 validation runs in JS so
 *    the "Just create source" skip path isn't blocked by hidden invalid
 *    fields). Selects submit through an explicit hidden input.
 *  - `variant="first-run"` — the /setup flow's shortened per-type form.
 *    Controlled inputs, no native `required` (the submit button is gated on
 *    completeness instead), `url` fields render as plain text inputs.
 *
 * `namePrefix` controls the submitted field name — the wizard and first-run
 * flows submit `dest_field_<key>` so the server's shared preflight/create
 * code can read one shape. These names are load-bearing: a mismatch makes
 * create actions silently drop config.
 *
 * A `showWhen` field whose controlling value doesn't match renders nothing —
 * and therefore submits nothing. The server actions mirror that: create
 * never stores hidden fields, and update drops a stored config key once its
 * controlling value stops matching.
 */
export function ConditionalDestField({
  field,
  type,
  fieldValues,
  setFieldValue,
  disabled = false,
  layout = "stacked",
  variant = "form",
  namePrefix = "",
  idPrefix = "dest-",
}: {
  field: RenderableDestinationField;
  type: DestinationType;
  fieldValues: Record<string, string>;
  setFieldValue: (key: string, value: string) => void;
  /** Disable every control — e.g. while the edit form's action is pending. */
  disabled?: boolean;
  /**
   * "stacked" — label above the input (create dialog).
   * "row" — 200px label column, matching the Configuration tab's other forms.
   * Only meaningful for `variant="form"`; the other variants are stacked.
   */
  layout?: "stacked" | "row";
  variant?: "form" | "wizard" | "first-run";
  /** Prefix for the submitted input name, e.g. "dest_field_". */
  namePrefix?: string;
  /** Prefix for the DOM id, e.g. "pipeline-dest-" / "fr-dest-". */
  idPrefix?: string;
}) {
  if (!isDestinationFieldVisible(field, fieldValues)) return null;
  const fieldId = `${idPrefix}${field.key}`;
  const fieldName = `${namePrefix}${field.key}`;
  const currentValue = fieldValues[field.key] ?? field.defaultValue ?? "";

  const label =
    variant === "form" ? (
      <Label
        htmlFor={fieldId}
        className={
          layout === "row"
            ? "flex items-center gap-2 pt-2 text-sm font-medium"
            : "flex items-center gap-2"
        }
      >
        <span>{field.label}</span>
        {field.kind === "secret" ? (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            encrypted at rest
          </span>
        ) : null}
        {type === "webhook" && field.key === "signing_secret" ? (
          <span className="rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            auto-generates if blank
          </span>
        ) : null}
      </Label>
    ) : (
      <Label htmlFor={fieldId}>
        {field.label}
        {field.required === false ? (
          <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
        ) : null}
      </Label>
    );

  const control =
    field.inputType === "select" && field.options ? (
      variant === "form" ? (
        <Select
          name={fieldName}
          value={fieldValues[field.key] ?? field.defaultValue ?? field.options[0]?.value ?? ""}
          onValueChange={(value) => setFieldValue(field.key, value)}
          disabled={disabled}
        >
          <SelectTrigger id={fieldId} className="h-10 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Select
            value={currentValue}
            onValueChange={(value) => setFieldValue(field.key, value)}
          >
            <SelectTrigger id={fieldId} className="h-auto w-full px-3 py-2.5">
              <SelectValue placeholder={field.placeholder} />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {field.options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Radix Select is not a native form control — submit via a
              hidden input so the create action still reads dest_field_*. */}
          <input type="hidden" name={fieldName} value={currentValue} />
        </>
      )
    ) : field.inputType === "textarea" ? (
      <Textarea
        id={fieldId}
        name={fieldName}
        {...(variant === "first-run" ? {} : { rows: 5 })}
        // The wizard's inputs are uncontrolled — see the variant note above.
        {...(variant === "wizard"
          ? { defaultValue: field.defaultValue }
          : { value: currentValue })}
        placeholder={field.placeholder}
        required={variant === "form" && field.required !== false}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className={
          variant === "first-run"
            ? "h-28 font-mono text-xs"
            : "h-44 resize-y font-mono text-xs field-sizing-fixed"
        }
        onChange={(e) => setFieldValue(field.key, e.target.value)}
      />
    ) : (
      <Input
        id={fieldId}
        name={fieldName}
        type={
          variant === "first-run"
            ? field.inputType === "password"
              ? "password"
              : "text"
            : variant === "wizard" && field.inputType === "select"
              ? "text"
              : field.inputType ?? "text"
        }
        // The wizard's inputs are uncontrolled — see the variant note above.
        {...(variant === "wizard"
          ? { defaultValue: field.defaultValue }
          : { value: currentValue })}
        placeholder={field.placeholder}
        // No native `required` outside the full form — the wizard validates
        // step 2 in JS (continueToStep) so "Just create source" isn't blocked
        // by hidden invalid fields, and first-run gates its submit button.
        required={variant === "form" && field.required !== false}
        autoComplete={
          variant === "form" && field.kind === "secret" ? "new-password" : "off"
        }
        spellCheck={variant === "wizard" ? undefined : false}
        disabled={disabled}
        onChange={(e) => setFieldValue(field.key, e.target.value)}
      />
    );
  const hint = field.hint ? (
    <p className="text-xs text-muted-foreground">{field.hint}</p>
  ) : null;
  if (variant === "form" && layout === "row") {
    return (
      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start">
        {label}
        <div className="space-y-1.5">
          {control}
          {hint}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {label}
      {control}
      {hint}
    </div>
  );
}
