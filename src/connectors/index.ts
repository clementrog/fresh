import type { AppEnv } from "../config/env.js";
import type { ConnectorConfig, SourceConnector } from "../domain/types.js";
import { ClaapConnector } from "./claap.js";
import { LinearConnector } from "./linear.js";
import { MarketFindingsConnector } from "./market-findings.js";
import { NotionConnector } from "./notion.js";
import { SlackConnector } from "./slack.js";

export function createConnectorRegistry(env: AppEnv): Record<ConnectorConfig["source"], SourceConnector<any>> {
  return {
    slack: new SlackConnector(env),
    notion: new NotionConnector(env),
    claap: new ClaapConnector(env),
    linear: new LinearConnector(env),
    "market-findings": new MarketFindingsConnector()
  };
}
