"use server";

import { requireSession } from "../session";
import {
  findActiveDataContractForSource,
} from "./repository";
import type { InferredDataContract } from "./inference";
import { synthesizePayload } from "./synth";

export interface SyntheticPayloadOption {
  cluster_id: string;
  cluster_name: string;
  sample_count: number;
  payload: unknown;
}

export interface SyntheticPayloadsResponse {
  available: boolean;
  data_contract_id: string | null;
  data_contract_name: string | null;
  options: SyntheticPayloadOption[];
  /** Set when the source has no active map yet; UI shows a hint to
   *  run Understand source or wait for auto-draft. */
  reason?: "no_active_map" | "no_clusters";
}

/**
 * Server action used by the SendTestEventDialog "From Data Contract" tab.
 * Returns one synthesized payload per cluster in the source's active
 * Data Contract. UI lets the operator click a cluster to drop its payload
 * into the editable JSON textarea.
 */
export async function getSyntheticPayloadsForSourceAction(
  sourceId: string,
): Promise<SyntheticPayloadsResponse> {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const result = await findActiveDataContractForSource(workspaceId, sourceId);
  if (!result) {
    return {
      available: false,
      data_contract_id: null,
      data_contract_name: null,
      options: [],
      reason: "no_active_map",
    };
  }
  const inferred = result.version.inferred_schema as InferredDataContract;
  if (inferred.event_types.length === 0) {
    return {
      available: false,
      data_contract_id: result.map.id,
      data_contract_name: result.map.name,
      options: [],
      reason: "no_clusters",
    };
  }
  return {
    available: true,
    data_contract_id: result.map.id,
    data_contract_name: result.map.name,
    options: inferred.event_types.map((cluster) => {
      const { payload } = synthesizePayload(inferred, cluster.cluster_id);
      return {
        cluster_id: cluster.cluster_id,
        cluster_name: cluster.name,
        sample_count: cluster.sample_count,
        payload,
      };
    }),
  };
}
