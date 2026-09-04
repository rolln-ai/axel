// Render puts scaling settings in serviceDetails. Reject conflicting legacy
// fields and autoscaling: numInstances only describes manually scaled services.
export function renderServiceInstanceCount(service) {
  const nested = service.serviceDetails?.numInstances;
  const direct = service.numInstances;
  if (direct !== undefined && nested !== undefined && direct !== nested) return undefined;
  const autoscaling = service.serviceDetails?.autoscaling;
  if (autoscaling !== undefined && autoscaling?.enabled !== false) return undefined;
  return nested ?? direct;
}
