"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { endSupportSession, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { resolveCrmActor } from "@/server/crm/request";
import {
  addContactIdentity, assignContacts, createContact, eraseContact, linkContactCompany, mergeCrmContacts, removeContactIdentity, searchContacts, setContactConsent,
  setContactsArchived, unlinkContactCompany, updateContact, type ContactInput, type ContactPatch,
} from "@/server/crm/contacts";
import { createCompany, deleteCompany, searchCompanies, setCompaniesArchived, updateCompany, type CompanyInput } from "@/server/crm/companies";
import { createFolder, createTag, deleteFolder, deleteTag, mergeTags, renameFolder, tagCompany, tagContacts, updateTag } from "@/server/crm/tags";
import { createCustomField, reorderCustomFields, setCustomFieldArchived, setRecordFields, updateCustomField, type FieldDefinitionInput } from "@/server/crm/fields";
import { countContacts, matchingContactIds } from "@/server/crm/directory";
import { createSmartList, deleteSmartList, duplicateSmartList, pinSmartList, setDefaultSmartList, updateSmartList, type SmartListInput } from "@/server/crm/smart-lists";
import { addNote, deleteNote, editNote, pinNote, type NoteRecordType } from "@/server/crm/notes";
import { getTimeline } from "@/server/crm/timeline";
import { addStage, archivePipeline, createPipeline, deleteStage, reorderStages, updatePipeline, updateStage, type StageKind } from "@/server/crm/pipelines";
import { archiveOpportunities, bulkMoveOpportunities, closeOpportunity, createOpportunity, getBoard, moveOpportunity, reopenOpportunity, setOpportunityTags, updateOpportunity, type OpportunityInput } from "@/server/crm/opportunities";
import { addTaskComment, createTask, listTaskComments, setTaskStatus, updateTask, type TaskInput, type TaskStatus } from "@/server/crm/tasks";
import { advanceImportFor, cancelImport, createImportJob, getImportJob, rollbackImport, startImport, startValidation, type ImportEntity, type ImportOptions } from "@/server/crm/imports";
import { setPermissionOverride } from "@/server/crm/permissions";
import { updateWorkspaceSettings } from "@/server/crm/workspace";
import type { Permission } from "@/lib/permissions";
import type { Channel } from "@/lib/messaging";

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

/** Revalidates the CRM pages the change shows on, for the client workspace and the agency's view of it. */
function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Agency support sessions
// ---------------------------------------------------------------------------

export async function startSupportSessionAction(orgId: string, mode: "read" | "write", reason: string) {
  return guard(async () => {
    const user = await requireAgencyOrThrow();
    const s = await startSupportSession(user, uuid.parse(orgId), { mode: z.enum(["read", "write"]).parse(mode), reason: z.string().max(500).parse(reason) });
    revalidatePath(`/admin/clients/${orgId}/crm`, "layout");
    return s;
  });
}

export async function endSupportSessionAction(orgId: string) {
  return guard(async () => {
    const user = await requireAgencyOrThrow();
    await endSupportSession(user, uuid.parse(orgId));
    revalidatePath(`/admin/clients/${orgId}/crm`, "layout");
    return true;
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const selectionSchema = z.object({
  ids: z.array(uuid).max(5000).optional(),
  query: z.object({ smartListId: uuid.nullable().optional(), filter: z.unknown().optional(), search: z.string().max(120).optional(), archived: z.enum(["exclude", "only", "include"]).optional() }).optional(),
});
type Selection = z.infer<typeof selectionSchema>;

async function selectedIds(actor: CrmActor, sel: Selection): Promise<string[]> {
  const s = selectionSchema.parse(sel);
  if (s.ids?.length) return s.ids;
  if (s.query) return matchingContactIds(actor, s.query);
  throw new AppError("invalid_input", "Select at least one contact.");
}

export async function createContactAction(orgId: string | null, input: ContactInput) {
  return act(orgId, "contacts.create", (actor) => createContact(actor, input));
}

export async function updateContactAction(orgId: string | null, id: string, patch: ContactPatch & { customFields?: Record<string, unknown> }, version?: number) {
  return act(orgId, "contacts.edit", (actor) => updateContact(actor, uuid.parse(id), patch, version));
}

export async function addIdentityAction(orgId: string | null, contactId: string, kind: "email" | "phone", value: string) {
  return act(orgId, "contacts.edit", (actor) => addContactIdentity(actor, uuid.parse(contactId), { kind: z.enum(["email", "phone"]).parse(kind), value: z.string().max(320).parse(value) }));
}

export async function removeIdentityAction(orgId: string | null, contactId: string, identityId: string) {
  return act(orgId, "contacts.edit", (actor) => removeContactIdentity(actor, uuid.parse(contactId), uuid.parse(identityId)));
}

export async function assignContactsAction(orgId: string | null, sel: Selection, ownerId: string | null) {
  return act(orgId, "contacts.edit", async (actor) => assignContacts(actor, await selectedIds(actor, sel), ownerId ? uuid.parse(ownerId) : null));
}

export async function archiveContactsAction(orgId: string | null, sel: Selection, archived: boolean) {
  return act(orgId, "contacts.delete", async (actor) => setContactsArchived(actor, await selectedIds(actor, sel), archived));
}

export async function tagContactsAction(orgId: string | null, sel: Selection, add: string[], remove: string[]) {
  return act(orgId, "contacts.edit", async (actor) => tagContacts(actor, { contactIds: await selectedIds(actor, sel), addTagIds: z.array(uuid).max(50).parse(add), removeTagIds: z.array(uuid).max(50).parse(remove) }));
}

export async function linkCompanyAction(orgId: string | null, contactId: string, companyId: string, title?: string | null, primary?: boolean) {
  return act(orgId, "contacts.edit", (actor) => linkContactCompany(actor, { contactId: uuid.parse(contactId), companyId: uuid.parse(companyId), title: title ?? null, primary }));
}

export async function unlinkCompanyAction(orgId: string | null, contactId: string, companyId: string) {
  return act(orgId, "contacts.edit", (actor) => unlinkContactCompany(actor, { contactId: uuid.parse(contactId), companyId: uuid.parse(companyId) }));
}

export async function setConsentAction(orgId: string | null, contactId: string, input: { channel: Channel; purpose: "service" | "marketing"; status: "granted" | "revoked"; evidence: string }) {
  return act(orgId, "consent.manage", (actor) => setContactConsent(actor, uuid.parse(contactId), input));
}

export async function mergeContactsAction(orgId: string | null, keptId: string, mergedId: string, reason: string) {
  return act(orgId, "contacts.merge", (actor) => mergeCrmContacts(actor, { keptId: uuid.parse(keptId), mergedId: uuid.parse(mergedId), reason: z.string().max(500).parse(reason) }));
}

export async function eraseContactAction(orgId: string | null, contactId: string, reason: string) {
  return act(orgId, "contacts.delete", (actor) => eraseContact(actor, uuid.parse(contactId), z.string().max(500).parse(reason)));
}

export async function setFieldsAction(orgId: string | null, entity: "contact" | "company" | "opportunity", id: string, values: Record<string, unknown>) {
  return act(orgId, "crm.view", (actor) => setRecordFields(actor, z.enum(["contact", "company", "opportunity"]).parse(entity), uuid.parse(id), values));
}

export async function countContactsAction(orgId: string | null, query: Selection["query"]) {
  return act(orgId, "contacts.view", (actor) => countContacts(actor, query ?? {}), { refresh: false });
}

export async function searchContactsAction(orgId: string | null, q: string) {
  return act(orgId, "contacts.view", (actor) => searchContacts(actor, z.string().max(80).parse(q)), { refresh: false });
}

export async function timelineAction(orgId: string | null, target: { contactId?: string; companyId?: string; opportunityId?: string }, before?: string) {
  return act(orgId, "crm.view", (actor) => getTimeline(actor, target, { before }), { refresh: false });
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function createCompanyAction(orgId: string | null, input: CompanyInput) {
  return act(orgId, "companies.create", (actor) => createCompany(actor, input));
}

export async function updateCompanyAction(orgId: string | null, id: string, input: Partial<CompanyInput>, version?: number) {
  return act(orgId, "companies.edit", (actor) => updateCompany(actor, uuid.parse(id), input, version));
}

export async function archiveCompaniesAction(orgId: string | null, ids: string[], archived: boolean) {
  return act(orgId, "contacts.delete", (actor) => setCompaniesArchived(actor, z.array(uuid).max(2000).parse(ids), archived));
}

export async function deleteCompanyAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.delete", (actor) => deleteCompany(actor, uuid.parse(id)));
}

export async function tagCompanyAction(orgId: string | null, companyId: string, add: string[], remove: string[]) {
  return act(orgId, "companies.edit", (actor) => tagCompany(actor, { companyId: uuid.parse(companyId), addTagIds: add, removeTagIds: remove }));
}

export async function searchCompaniesAction(orgId: string | null, q: string) {
  return act(orgId, "companies.view", (actor) => searchCompanies(actor, z.string().max(80).parse(q)), { refresh: false });
}

// ---------------------------------------------------------------------------
// Tags, folders, fields
// ---------------------------------------------------------------------------

export async function createTagAction(orgId: string | null, input: { name: string; color?: string; description?: string | null; folderId?: string | null }) {
  return act(orgId, "tags.manage", (actor) => createTag(actor, input));
}
export async function updateTagAction(orgId: string | null, id: string, input: { name?: string; color?: string; description?: string | null; folderId?: string | null }) {
  return act(orgId, "tags.manage", (actor) => updateTag(actor, uuid.parse(id), input));
}
export async function deleteTagAction(orgId: string | null, id: string) {
  return act(orgId, "tags.manage", (actor) => deleteTag(actor, uuid.parse(id)));
}
export async function mergeTagsAction(orgId: string | null, targetId: string, sourceIds: string[]) {
  return act(orgId, "tags.manage", (actor) => mergeTags(actor, { targetId: uuid.parse(targetId), sourceIds: z.array(uuid).max(50).parse(sourceIds) }));
}
export async function createFolderAction(orgId: string | null, kind: string, name: string) {
  return act(orgId, "crm.view", (actor) => createFolder(actor, { kind, name }));
}
export async function renameFolderAction(orgId: string | null, id: string, name: string) {
  return act(orgId, "crm.view", (actor) => renameFolder(actor, uuid.parse(id), name));
}
export async function deleteFolderAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => deleteFolder(actor, uuid.parse(id)));
}
export async function createFieldAction(orgId: string | null, input: FieldDefinitionInput) {
  return act(orgId, "fields.manage", (actor) => createCustomField(actor, input));
}
export async function updateFieldAction(orgId: string | null, id: string, input: Parameters<typeof updateCustomField>[2]) {
  return act(orgId, "fields.manage", (actor) => updateCustomField(actor, uuid.parse(id), input));
}
export async function archiveFieldAction(orgId: string | null, id: string, archived: boolean) {
  return act(orgId, "fields.manage", (actor) => setCustomFieldArchived(actor, uuid.parse(id), archived));
}
export async function reorderFieldsAction(orgId: string | null, entity: "contact" | "company" | "opportunity", ids: string[]) {
  return act(orgId, "fields.manage", (actor) => reorderCustomFields(actor, entity, z.array(uuid).max(200).parse(ids)));
}

// ---------------------------------------------------------------------------
// Smart Lists
// ---------------------------------------------------------------------------

export async function createSmartListAction(orgId: string | null, input: SmartListInput) {
  return act(orgId, "crm.view", (actor) => createSmartList(actor, input));
}
export async function updateSmartListAction(orgId: string | null, id: string, input: Partial<SmartListInput>) {
  return act(orgId, "crm.view", (actor) => updateSmartList(actor, uuid.parse(id), input));
}
export async function duplicateSmartListAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => duplicateSmartList(actor, uuid.parse(id)));
}
export async function deleteSmartListAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => deleteSmartList(actor, uuid.parse(id)));
}
export async function pinSmartListAction(orgId: string | null, id: string, pinned: boolean) {
  return act(orgId, "crm.view", (actor) => pinSmartList(actor, uuid.parse(id), pinned));
}
export async function setDefaultSmartListAction(orgId: string | null, id: string | null, entity: "contact" | "company" | "opportunity" = "contact") {
  return act(orgId, "smartlists.share", (actor) => setDefaultSmartList(actor, id ? uuid.parse(id) : null, entity));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function addNoteAction(orgId: string | null, type: NoteRecordType, recordId: string, body: string) {
  return act(orgId, "notes.write", (actor) => addNote(actor, z.enum(["contact", "company", "opportunity"]).parse(type), uuid.parse(recordId), body));
}
export async function editNoteAction(orgId: string | null, id: string, body: string) {
  return act(orgId, "notes.write", (actor) => editNote(actor, uuid.parse(id), body));
}
export async function deleteNoteAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => deleteNote(actor, uuid.parse(id)));
}
export async function pinNoteAction(orgId: string | null, id: string, pinned: boolean) {
  return act(orgId, "notes.write", (actor) => pinNote(actor, uuid.parse(id), pinned));
}

// ---------------------------------------------------------------------------
// Pipelines and deals
// ---------------------------------------------------------------------------

export async function createPipelineAction(orgId: string | null, input: { name: string; description?: string | null; stages?: Array<{ name: string; kind?: StageKind; probability?: number | null }> }) {
  return act(orgId, "pipelines.manage", (actor) => createPipeline(actor, input));
}
export async function updatePipelineAction(orgId: string | null, id: string, input: { name?: string; description?: string | null; isDefault?: boolean }) {
  return act(orgId, "pipelines.manage", (actor) => updatePipeline(actor, uuid.parse(id), input));
}
export async function archivePipelineAction(orgId: string | null, id: string) {
  return act(orgId, "pipelines.manage", (actor) => archivePipeline(actor, uuid.parse(id)));
}
export async function addStageAction(orgId: string | null, pipelineId: string, input: { name: string; kind?: StageKind; probability?: number | null; afterStageId?: string | null }) {
  return act(orgId, "pipelines.manage", (actor) => addStage(actor, uuid.parse(pipelineId), input));
}
export async function updateStageAction(orgId: string | null, stageId: string, input: { name?: string; probability?: number | null; color?: string | null; kind?: StageKind }) {
  return act(orgId, "pipelines.manage", (actor) => updateStage(actor, uuid.parse(stageId), input));
}
export async function reorderStagesAction(orgId: string | null, pipelineId: string, ids: string[]) {
  return act(orgId, "pipelines.manage", (actor) => reorderStages(actor, uuid.parse(pipelineId), z.array(uuid).max(30).parse(ids)));
}
export async function deleteStageAction(orgId: string | null, stageId: string, moveTo: string | null) {
  return act(orgId, "pipelines.manage", (actor) => deleteStage(actor, uuid.parse(stageId), moveTo ? uuid.parse(moveTo) : null));
}
export async function createOpportunityAction(orgId: string | null, input: OpportunityInput) {
  return act(orgId, "opportunities.create", (actor) => createOpportunity(actor, input));
}
export async function updateOpportunityAction(orgId: string | null, id: string, patch: Parameters<typeof updateOpportunity>[2], version?: number) {
  return act(orgId, "opportunities.edit", (actor) => updateOpportunity(actor, uuid.parse(id), patch, version));
}
export async function moveOpportunityAction(orgId: string | null, id: string, stageId: string, version?: number, lostReason?: string | null) {
  return act(orgId, "opportunities.edit", (actor) => moveOpportunity(actor, uuid.parse(id), { stageId: uuid.parse(stageId), expectedVersion: version, lostReason }));
}
export async function closeOpportunityAction(orgId: string | null, id: string, outcome: "won" | "lost", lostReason?: string | null) {
  return act(orgId, "opportunities.edit", (actor) => closeOpportunity(actor, uuid.parse(id), z.enum(["won", "lost"]).parse(outcome), { lostReason }));
}
export async function reopenOpportunityAction(orgId: string | null, id: string, stageId?: string | null) {
  return act(orgId, "opportunities.reopen", (actor) => reopenOpportunity(actor, uuid.parse(id), stageId ? uuid.parse(stageId) : null));
}
export async function archiveOpportunitiesAction(orgId: string | null, ids: string[]) {
  return act(orgId, "opportunities.delete", (actor) => archiveOpportunities(actor, z.array(uuid).max(2000).parse(ids)));
}
export async function bulkMoveOpportunitiesAction(orgId: string | null, ids: string[], stageId: string) {
  return act(orgId, "opportunities.edit", (actor) => bulkMoveOpportunities(actor, z.array(uuid).max(500).parse(ids), uuid.parse(stageId)));
}
export async function setOpportunityTagsAction(orgId: string | null, id: string, add: string[], remove: string[]) {
  return act(orgId, "opportunities.edit", (actor) => setOpportunityTags(actor, uuid.parse(id), { add, remove }));
}
export async function boardAction(orgId: string | null, pipelineId: string, opts: { search?: string; mine?: boolean; closedDays?: number }) {
  return act(orgId, "sales.view", (actor) => getBoard(actor, uuid.parse(pipelineId), opts), { refresh: false });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTaskAction(orgId: string | null, input: TaskInput) {
  return act(orgId, "tasks.manage", (actor) => createTask(actor, input));
}
export async function updateTaskAction(orgId: string | null, id: string, patch: Partial<TaskInput>) {
  return act(orgId, "tasks.manage", (actor) => updateTask(actor, uuid.parse(id), patch));
}
export async function setTaskStatusAction(orgId: string | null, id: string, status: TaskStatus) {
  return act(orgId, "tasks.manage", (actor) => setTaskStatus(actor, uuid.parse(id), status));
}
export async function addTaskCommentAction(orgId: string | null, id: string, body: string) {
  return act(orgId, "tasks.manage", (actor) => addTaskComment(actor, uuid.parse(id), body));
}
export async function taskCommentsAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => listTaskComments(actor, uuid.parse(id)), { refresh: false });
}

// ---------------------------------------------------------------------------
// Imports, permissions, workspace settings
// ---------------------------------------------------------------------------

export async function createImportAction(orgId: string | null, entity: ImportEntity, fileName: string, csv: string) {
  return act(orgId, "contacts.import", (actor) => createImportJob(actor, { entity: z.enum(["contact", "company"]).parse(entity), fileName: z.string().max(200).parse(fileName), csv: z.string().parse(csv) }));
}
export async function startValidationAction(orgId: string | null, id: string, mapping: Record<string, string>, options: ImportOptions) {
  return act(orgId, "contacts.import", (actor) => startValidation(actor, uuid.parse(id), { mapping, options }));
}
export async function startImportAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.import", (actor) => startImport(actor, uuid.parse(id)));
}
export async function advanceImportAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.import", async (actor) => {
    await advanceImportFor(actor, uuid.parse(id));
    return getImportJob(actor, id);
  }, { refresh: false });
}
export async function getImportAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.import", (actor) => getImportJob(actor, uuid.parse(id)), { refresh: false });
}
export async function cancelImportAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.import", (actor) => cancelImport(actor, uuid.parse(id)));
}
export async function rollbackImportAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.import", (actor) => rollbackImport(actor, uuid.parse(id)));
}
export async function setPermissionOverrideAction(orgId: string | null, userId: string, permission: string, effect: "grant" | "revoke" | null, reason?: string) {
  return act(orgId, "crm.permissions.manage", (actor) => setPermissionOverride(actor, { userId: uuid.parse(userId), permission, effect, reason }));
}
export async function updateWorkspaceSettingsAction(orgId: string | null, input: { defaultCurrency?: string; defaultCallingCode?: string | null }) {
  return act(orgId, "crm.view", (actor) => updateWorkspaceSettings(actor, input));
}
