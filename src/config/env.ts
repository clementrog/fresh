import { envSchema } from "./schema.js";

export interface AppEnv {
  DATABASE_URL: string;
  NOTION_TOKEN?: string;
  NOTION_PARENT_PAGE_ID?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  TAVILY_API_KEY?: string;
  CLAAP_API_KEY?: string;
  LINEAR_API_KEY?: string;
  GITHUB_TOKEN?: string;
  DEFAULT_TIMEZONE?: string;
  DEFAULT_COMPANY_SLUG?: string;
  DEFAULT_COMPANY_NAME?: string;
  INTELLIGENCE_LLM_PROVIDER?: "openai" | "anthropic";
  INTELLIGENCE_LLM_MODEL?: string;
  DRAFT_LLM_PROVIDER?: "openai" | "anthropic" | "claude-cli";
  DRAFT_LLM_MODEL?: string;
  CLAUDE_CLI_PATH?: string;
  CLAUDE_CLI_MAX_BUDGET_USD?: number;
  CLAUDE_CLI_TIMEOUT_MS?: number;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: number;
  HTTP_PORT?: number;
  LOG_LEVEL?: string;
  NOTION_TONE_OF_VOICE_DB_ID?: string;
  ADMIN_ENABLED?: string;
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_ALLOW_REMOTE?: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  HUBSPOT_PORTAL_ID?: string;
  SALES_LLM_PROVIDER?: "openai" | "anthropic";
  SALES_LLM_MODEL?: string;
  NANO_LLM_PROVIDER?: "openai" | "anthropic";
  NANO_LLM_MODEL?: string;
}

export function loadEnv() {
  return envSchema.parse(process.env) as Required<AppEnv>;
}
