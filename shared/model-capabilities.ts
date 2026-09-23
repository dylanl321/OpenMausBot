/** A driver can support tools/images while an individual model cannot. */
export interface ModelCapabilities { tools?: boolean; images?: boolean }

export function capabilitiesForModel<T extends object>(capabilities: T, model?: { capabilities?: ModelCapabilities }): T {
  const result = { ...capabilities };
  if (model?.capabilities?.tools === false) Object.assign(result, {
    agentsMcp: false, computerMcp: false, localComputerMcp: false, composioMcp: false,
    browserMcp: false, phoneMcp: false, customMcp: false,
  });
  if (model?.capabilities?.images !== undefined) Object.assign(result, { images: model.capabilities.images });
  return result;
}
