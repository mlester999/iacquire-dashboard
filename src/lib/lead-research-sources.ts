export const RESEARCH_SOURCE_KEYS = ["openstreetmap", "company_website", "fsa_directory"] as const;
export type ResearchSourceKey = (typeof RESEARCH_SOURCE_KEYS)[number];

export function isResearchSourceKey(value: unknown): value is ResearchSourceKey {
  return RESEARCH_SOURCE_KEYS.some((key) => key === value);
}

export const FSA_DIRECTORY_NAME = "UK Food Standards Agency directory";
export const FSA_DIRECTORY_ATTRIBUTION = "Contains Food Standards Agency information licensed under the Open Government Licence v3.0.";
export const FSA_DIRECTORY_LICENCE = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/";
