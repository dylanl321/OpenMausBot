import type { InstanceInfo, ModelSelection } from "@/state/store";
import { capabilitiesForModel } from "../../shared/model-capabilities";

export function selectedModelCapabilities(instances: InstanceInfo[], selection: ModelSelection | undefined): NonNullable<InstanceInfo["capabilities"]> {
  const instance = selection && instances.find((entry) => entry.instanceId === selection.instanceId);
  if (!instance) return {};
  return capabilitiesForModel(instance.capabilities ?? {}, instance.models?.options?.find((model) => model.id === selection?.model));
}
