import { FSA_DIRECTORY_NAME } from "./lead-research-sources";

export const LEAD_LIST_MAX_BYTES = 256 * 1024;
export const LEAD_LIST_MAX_ROWS = 100;

export const LEAD_LIST_HEADERS = ["business_name", "website", "source_url", "industry", "region", "country"] as const;

export function leadSourceLabel(source: string): string | null {
  if (source === "tenant_upload") return "Workspace CSV";
  if (source === "synthetic_fixture") return "Synthetic discovery fixture";
  if (source === "approved_source") return "Approved-source discovery";
  if (source === "openstreetmap") return "OpenStreetMap";
  if (source === "fsa_directory") return FSA_DIRECTORY_NAME;
  return null;
}
