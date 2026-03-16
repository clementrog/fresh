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
  DEFAULT_TIMEZONE?: string;
  DEFAULT_COMPANY_SLUG?: string;
  DEFAULT_COMPANY_NAME?: string;
  INTELLIGENCE_LLM_PROVIDER?: "openai" | "anthropic";
  INTELLIGENCE_LLM_MODEL?: string;
  DRAFT_LLM_PROVIDER?: "openai" | "anthropic";
  DRAFT_LLM_MODEL?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: number;
  HTTP_PORT?: number;
  LOG_LEVEL?: string;
}

export function loadEnv() {
  return envSchema.parse(process.env) as Required<AppEnv>;
}
