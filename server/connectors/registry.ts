import type { Connector } from "./types.ts";
import { fakeConnector } from "../testing/fake-connector.ts";
import { gitlabConnector } from "./gitlab/index.ts";
import { jiraConnector } from "./jira/index.ts";
import { planeConnector } from "./plane/index.ts";

/** One import per connector. Nothing else in the server names a provider. */
export const CONNECTORS: Connector[] = [fakeConnector, jiraConnector, gitlabConnector, planeConnector];

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find(connector => connector.manifest.id === id);
}
