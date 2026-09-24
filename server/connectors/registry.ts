import type { Connector } from "./types.ts";
import { fakeConnector } from "../testing/fake-connector.ts";

/** One import per connector. Nothing else in the server names a provider. */
export const CONNECTORS: Connector[] = [fakeConnector];

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find(connector => connector.manifest.id === id);
}
