import "server-only";

// Reading and writing a workspace's native configuration for CRM Blueprints: readers (read.ts), writers (write.ts) and the in-use checks a
// rollback runs (usage.ts). Shared by the apply engine, capture and the setup checklist.
export { readEntry, readWorkspaceConfig } from "@/server/crm/blueprints/native-io/read";
export { createRecord, deleteRecord, storedConditions, templateContent, updateRecord } from "@/server/crm/blueprints/native-io/write";
export { inUseReason, referencedBy } from "@/server/crm/blueprints/native-io/usage";
export type { CreateOptions, EntriesByType, EntryMeta, NativeEntry, ReadOptions, WorkspaceConfig, WriteContext } from "@/server/crm/blueprints/native-io/types";
