export interface DeploymentCapabilities {
  configurableRawPayloadRetention: boolean;
  indexedSubjectErasure: boolean;
}

/**
 * Capabilities that depend on the full analytics and erasure-indexing path.
 * The small Compose profile has a fixed R2 lifecycle and no ClickHouse, so it
 * must not advertise controls that only change Postgres configuration.
 */
export function deploymentCapabilities(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentCapabilities {
  const smallSelfHost = env.AXEL_SELF_HOST_PROFILE === "small";
  return {
    configurableRawPayloadRetention: !smallSelfHost,
    indexedSubjectErasure: !smallSelfHost,
  };
}
