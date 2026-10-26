// Where a workspace's files may live, decided by the bucket they go to. The product's storage rule: managed storage is the Managed Maintenance plan's, within its fair-use limits; a
// client without the plan keeps large media in its OWN Google Drive or OneDrive. Everything a workspace needs to RUN (support requests, the signed contract, the project files
// iAcquire delivers, the company knowledge its employees read) is core and never waits on the plan: a lapse stops new managed media, it deletes nothing and locks nobody out.
//
// Every private bucket is classified here, and a test fails when a bucket is added without a class, so there is no upload path that was never asked the question. The server
// enforces the class at the one place all uploads pass (uploadPrivateFile): the screens' own checks are a courtesy, not the control.
//
// Google Drive and OneDrive connections are NOT BUILT (each needs an OAuth application registered with the provider). The policy therefore never reports an external drive as
// connected, and a client without the plan has no managed media storage until that connection exists: honest, not silent.

export const PRIVATE_BUCKETS = [
  "company-documents", "support-attachments", "project-files", "project-uploads", "portfolio-assets", "brand-assets", "aqi-attachments", "social-media", "proposal-documents", "staff-messages",
] as const;
export type PrivateBucket = (typeof PRIVATE_BUCKETS)[number];

/** core: needed to run the workspace, never gated by a plan (fair-use limits still apply). managed_media: large client media, the maintenance plan's managed storage. */
export type StorageClass = "core" | "managed_media";

export const BUCKET_STORAGE: Record<PrivateBucket, { class: StorageClass; what: string }> = {
  "company-documents": { class: "core", what: "Company knowledge documents the AI employees read" },
  "support-attachments": { class: "core", what: "Attachments on support requests" },
  "project-files": { class: "core", what: "Files iAcquire attaches to a client's projects (internal)" },
  "project-uploads": { class: "core", what: "Files a client uploads to their own projects" },
  "portfolio-assets": { class: "core", what: "iAcquire's portfolio images shown to clients" },
  "brand-assets": { class: "core", what: "A client's logo and brand pictures used across their website and documents" },
  "aqi-attachments": { class: "core", what: "Files attached in the AQi assistant" },
  "social-media": { class: "managed_media", what: "Pictures and videos for social posts" },
  "proposal-documents": { class: "core", what: "Proposal PDFs and signed documents (records the business must keep)" },
  "staff-messages": { class: "core", what: "Attachments in iAcquire's internal staff messages" },
};

export interface StorageFacts {
  /** The workspace's maintenance plan entitles it to managed storage right now (one answer with Automation Studio: src/lib/entitlements.ts). */
  managedStorage: boolean;
}

export interface StorageDecision {
  allowed: boolean;
  class: StorageClass;
  /** Why not, in the person's words. Null when allowed. */
  reason: string | null;
}

export function storageDecision(bucket: PrivateBucket, facts: StorageFacts): StorageDecision {
  const entry = BUCKET_STORAGE[bucket];
  if (!entry) return { allowed: false, class: "managed_media", reason: "That storage area does not exist." };
  if (entry.class === "core") return { allowed: true, class: "core", reason: null };
  if (facts.managedStorage) return { allowed: true, class: "managed_media", reason: null };
  return {
    allowed: false,
    class: "managed_media",
    reason: "Managed media storage is included with the Managed Maintenance plan. Without it, pictures and videos are kept in your own Google Drive or OneDrive, which cannot be connected yet. Files you already uploaded stay safe and available.",
  };
}
