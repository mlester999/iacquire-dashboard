import { getWorkspace } from "@/server/crm/workspace";
import { listMemberAccess } from "@/server/crm/permissions";
import { CONTACT_IMPORT_TARGETS, COMPANY_IMPORT_TARGETS, listImportJobs } from "@/server/crm/imports";
import { listExportJobs } from "@/server/crm/exports";
import { listCustomFields } from "@/server/crm/fields";
import { auditSupportView, listSupportSessionsForClient, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { PermissionsSettings, ProviderSettings, SupportAccessLog } from "@/components/crm/settings-screens";
import { ImportsExports } from "@/components/crm/imports-exports";

export async function ProviderView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const workspace = await getWorkspace(actor);
  await auditSupportView(actor, "crm_provider");
  const canEditDefaults = !scope.readOnly && (actor.can("workspace.manage_profile") || actor.can("crm.provider.manage"));
  return <ProviderSettings scope={scope} workspace={workspace} canEditDefaults={canEditDefaults} />;
}

export async function PermissionsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const members = await listMemberAccess(actor);
  await auditSupportView(actor, "crm_permissions");
  return <PermissionsSettings scope={scope} members={members} />;
}

export async function DataView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [jobs, exports, contactFields, companyFields] = await Promise.all([
    listImportJobs(actor, 15),
    actor.can("contacts.export") ? listExportJobs(actor, 15) : Promise.resolve(null),
    listCustomFields(actor, "contact"),
    actor.can("companies.view") ? listCustomFields(actor, "company") : Promise.resolve([]),
  ]);
  await auditSupportView(actor, "crm_imports");
  const targets = {
    contact: [
      ...Object.entries(CONTACT_IMPORT_TARGETS).map(([value, t]) => ({ value, label: t.label })),
      ...contactFields.filter((f) => !f.archived).map((f) => ({ value: `cf:${f.key}`, label: `${f.label} (custom field)` })),
    ],
    company: [
      ...Object.entries(COMPANY_IMPORT_TARGETS).map(([value, t]) => ({ value, label: t.label })),
      ...companyFields.filter((f) => !f.archived).map((f) => ({ value: `cf:${f.key}`, label: `${f.label} (custom field)` })),
    ],
  };
  return <ImportsExports scope={scope} jobs={JSON.parse(JSON.stringify(jobs))} exports={exports} targets={targets} />;
}

export async function AccessView({ actor }: { actor: CrmActor }) {
  const sessions = await listSupportSessionsForClient(actor);
  return <SupportAccessLog sessions={sessions} />;
}
