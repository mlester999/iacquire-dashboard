// Serializable shapes the forms screens receive from their server views. Type-only: nothing server-side reaches the browser.
export type { FormBuilderOptions, FormDetail, FormSummary, FormVersionView } from "@/server/crm/forms/definitions";
export type { FormSubmissionView, SubmissionPage, SubmissionStatus } from "@/server/crm/forms/submissions";

export type FormTab = "build" | "after" | "settings" | "submissions" | "versions";
export const FORM_TABS: readonly FormTab[] = ["build", "after", "settings", "submissions", "versions"];
