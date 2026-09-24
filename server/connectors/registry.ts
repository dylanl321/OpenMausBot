import type { Connector } from "./types.ts";
import { fakeConnector } from "../testing/fake-connector.ts";
import { jiraConnector } from "./jira/index.ts";

/** One import per connector. Nothing else in the server names a provider. */
export const CONNECTORS: Connector[] = [fakeConnector, jiraConnector];

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find(connector => connector.manifest.id === id);
}
