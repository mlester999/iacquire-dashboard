export const AUTOMATION_QA_PORT: number;
export const AUTOMATION_QA_LLM_PORT: number;
export const AUTOMATION_QA_URL: string;
export const AUTOMATION_QA_LLM_URL: string;
export const AUTOMATION_QA_DATA_DIR: string;
export const AUTOMATION_QA_DIST_DIR: string;
export const AUTOMATION_QA_ENV: Record<string, string>;
export function assertAutomationQaIsolated(options?: {
  root?: string;
  env?: Record<string, string | undefined>;
}): void;
