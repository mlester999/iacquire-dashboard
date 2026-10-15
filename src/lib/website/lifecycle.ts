// Where a website is on its way to going live. Plain data, so the browser and the server read the same labels.
export type Lifecycle = "draft" | "ready_for_review" | "changes_requested" | "approved" | "published" | "publication_failed" | "archived";

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  draft: "Draft", ready_for_review: "Ready for review", changes_requested: "Changes requested", approved: "Approved", published: "Published", publication_failed: "Publication failed", archived: "Archived",
};
