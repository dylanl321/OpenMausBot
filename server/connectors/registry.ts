import type { Connector } from "./types.ts";
import { fakeConnector } from "../testing/fake-connector.ts";
import { gitlabConnector } from "./gitlab/index.ts";
import { jiraConnector } from "./jira/index.ts";
import { planeConnector } from "./plane/index.ts";

const HOST_CONNECTORS: Connector[] = [jiraConnector, gitlabConnector, planeConnector];

/** The fake fixture stays available to tests. Production never registers it. */
export function includeTestConnectors(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

/** One import per connector. Nothing else in the server names a provider. */
export function connectorsFor(env: NodeJS.ProcessEnv = process.env): Connector[] {
  return includeTestConnectors(env) ? [fakeConnector, ...HOST_CONNECTORS] : [...HOST_CONNECTORS];
}

export const CONNECTORS: Connector[] = connectorsFor();

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find(connector => connector.manifest.id === id);
}
