export const CRM_QA_PORT: number;
export const CRM_QA_URL: string;
export const CRM_QA_DATA_DIR: string;
export const CRM_QA_ENV: Record<string, string>;
export function assertIsolated(options?: {
  root?: string;
  files?: string[];
  env?: Record<string, string | undefined>;
}): void;
