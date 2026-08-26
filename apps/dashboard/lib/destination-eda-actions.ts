"use server";

import { requireSession } from "./session";
import {
  getDestinationEdaSeries,
  type EdaDimension,
  type EdaPoint,
} from "./destination-metrics";
import { hasClickhouseUrl } from "./clickhouse";

export interface EdaActionResponse {
  ok: true;
  rows: EdaPoint[];
  windowHours: number;
  dimension: EdaDimension;
}

export interface EdaActionError {
  ok: false;
  message: string;
}

const DIMENSIONS: readonly EdaDimension[] = ["hour", "route", "status", "attempt_no"];
const WINDOW_HOURS = [24, 24 * 7, 24 * 30] as const;

/**
 * Server action that powers the EDA panel — given a destination + dimension +
 * window, returns aggregated points. Validates inputs strictly so the panel
 * cannot construct arbitrary queries by mutating client state.
 */
export async function fetchDestinationEdaAction(
  destinationId: string,
  dimension: EdaDimension,
  windowHours: number,
): Promise<EdaActionResponse | EdaActionError> {
  if (!hasClickhouseUrl()) {
    return { ok: false, message: "Analytics are not configured for this environment." };
  }
  if (!DIMENSIONS.includes(dimension)) {
    return { ok: false, message: `Unknown dimension: ${dimension}` };
  }
  if (!WINDOW_HOURS.includes(windowHours as (typeof WINDOW_HOURS)[number])) {
    return { ok: false, message: `Unsupported window: ${windowHours}h` };
  }

  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const timezone = session.activeWorkspace.workspace_timezone;

  const rows = await getDestinationEdaSeries(workspaceId, destinationId, dimension, windowHours, { timezone });
  return { ok: true, rows, dimension, windowHours };
}
