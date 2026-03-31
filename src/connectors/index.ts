import type { AppEnv } from "../config/env.js";
import type { ConnectorConfig, SourceConnector } from "../domain/types.js";
import type { LlmClient } from "../services/llm.js";
import { ClaapConnector } from "./claap.js";
import { GitHubConnector } from "./github.js";
import { LinearConnector } from "./linear.js";
import { MarketFindingsConnector } from "./market-findings.js";
import { NotionConnector } from "./notion.js";
export function createConnectorRegistry(env: AppEnv, llmClient?: LlmClient, doctrineMarkdown?: string): Record<ConnectorConfig["source"], SourceConnector<any>> {
  return {
    notion: new NotionConnector(env),
    claap: new ClaapConnector(env, llmClient, doctrineMarkdown),
    linear: new LinearConnector(env),
    "market-findings": new MarketFindingsConnector(),
    github: new GitHubConnector(env)
  };
}
