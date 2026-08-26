/**
 * Small, deterministic UX classifier for permanent data-shape failures. These
 * are the cases where replaying the exact same payload cannot possibly work;
 * the Inbox should send the operator to a repair surface instead.
 */
import { repairProposalsFromMessage } from "./inbox-repair";

export interface DeadLetterRepair {
  kind: "field_type" | "field_shape";
  title: string;
  detail: string;
  actionLabel: string;
  href: string | null;
}

export function dataTypeRepairFor(input: {
  reason: string;
  message: string;
  routeId?: string | null;
  destinationId?: string | null;
}): DeadLetterRepair | null {
  if (input.reason !== "delivery_dead") return null;

  const href = input.routeId
    ? `/routes/${encodeURIComponent(input.routeId)}?repair=field-type`
    : input.destinationId
      ? `/destinations/${encodeURIComponent(input.destinationId)}`
      : null;

  const exactProposal = repairProposalsFromMessage(input.message)[0];
  if (exactProposal) {
    const kind = exactProposal.repair.kind === "collapse_array" ? "field_shape" : "field_type";
    return {
      kind,
      title: exactProposal.title,
      detail: `${exactProposal.issue.path} arrives as ${exactProposal.issue.expected}, but the target column is ${exactProposal.issue.existing}. ${exactProposal.summary} Retrying unchanged data will fail again; confirm the fix here and Axel will replay the failed deliveries.`,
      actionLabel: "Fix data",
      href: input.routeId
        ? `/routes/${encodeURIComponent(input.routeId)}?repair=${kind === "field_shape" ? "field-shape" : "field-type"}`
        : href,
    };
  }

  const integer = /Cannot convert value to integer(?:\s*\(bad value\))?:?\s*([^"}\],\s]+)?/i.exec(
    input.message,
  );
  const boolToString = /Conversion from bool to (?:std::)?string is unsupported/i.test(input.message);
  const arrayToScalar = /Array specified for non-repeated field:?\s*([^"}\],\s]+)?/i.exec(
    input.message,
  );
  const explicitMismatch = /type[_ ]mismatch|schemaMismatches/i.test(input.message);
  if (!integer && !boolToString && !arrayToScalar && !explicitMismatch) return null;

  const repairKind = arrayToScalar ? "field-shape" : "field-type";
  const repairHref = input.routeId
    ? `/routes/${encodeURIComponent(input.routeId)}?repair=${repairKind}`
    : href;

  if (integer) {
    const value = integer[1] && !/^\[/.test(integer[1]) ? integer[1] : null;
    return {
      kind: "field_type",
      title: "Decimal value cannot fit an integer column",
      detail: `${value ? `The value ${value} has a fractional part. ` : ""}Retrying unchanged data will fail again. Axel can add the FLOAT64-to-INT64 conversion here; you only need to choose how decimals should round.`,
      actionLabel: "Fix data",
      href: repairHref,
    };
  }

  if (boolToString) {
    return {
      kind: "field_type",
      title: "Boolean value does not match the target text column",
      detail: "Retrying unchanged data will fail again. Axel can convert the incoming BOOL to Text (STRING) here, then replay the failed deliveries.",
      actionLabel: "Fix data",
      href: repairHref,
    };
  }

  if (arrayToScalar) {
    const field = arrayToScalar[1]?.replace(/[.,;:]+$/, "") ?? null;
    return {
      kind: "field_shape",
      title: "Array value does not fit a scalar column",
      detail: `The incoming${field ? ` ${field}` : ""} field is an array, but the target column is not REPEATED. Retrying unchanged data will fail again. Axel can add a Collapse arrays to text step here, then replay the failed deliveries.`,
      actionLabel: "Fix data",
      href: repairHref,
    };
  }

  return {
    kind: "field_type",
    title: "Incoming value does not match the target column type",
    detail: "Retrying unchanged data will fail again. Axel can identify the field and offer a safe conversion here before replaying the failed deliveries.",
    actionLabel: "Fix data",
    href: repairHref,
  };
}
