import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listFolders } from "@/server/crm/tags";
import { getCommunicationSettings, listTemplates, listTestDestinations, listWhatsappTemplates } from "@/server/crm/message-templates";
import { TemplatesWorkspace } from "@/components/crm/templates/templates-workspace";
import { customValueTokenCatalog } from "@/server/crm/custom-values";
import { CustomValueTokensProvider } from "@/components/crm/custom-values/token-catalog";

type SP = Record<string, string | string[] | undefined>;
const TABS = ["templates", "canned", "whatsapp"] as const;

/**
 * Message templates and canned replies. Everyone who works the inbox can read them (the same rule as the row-level security policy);
 * owners and managers write them. Approving wording for automated use, and test sends, are the client's own: an agency support session can
 * prepare drafts but never approves or sends. Nothing secret is loaded here: test destinations are the workspace's own addresses.
 */
export async function TemplatesView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const canManage = actor.can("templates.manage");
  const [all, whatsapp, folders, channels, destinations, customValues] = await Promise.all([
    listTemplates(actor, { includeArchived: true }),
    listWhatsappTemplates(actor),
    listFolders(actor, "template"),
    getCommunicationSettings(actor),
    canManage ? listTestDestinations(actor) : Promise.resolve([]),
    // The workspace's configuration values: offered in the token picker and accepted by the live checks, exactly as the server checks.
    customValueTokenCatalog(actor),
  ]);
  await auditSupportView(actor, "templates");
  const tabParam = typeof searchParams?.tab === "string" ? searchParams.tab : "";
  const tab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as (typeof TABS)[number]) : "templates";
  return (
    <CustomValueTokensProvider values={customValues}>
    <TemplatesWorkspace
      scope={scope}
      templates={JSON.parse(JSON.stringify(all.filter((t) => t.kind === "template")))}
      cannedReplies={JSON.parse(JSON.stringify(all.filter((t) => t.kind === "canned_reply")))}
      whatsappTemplates={JSON.parse(JSON.stringify(whatsapp))}
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      channels={channels.map((c) => ({ channel: c.channel, enabled: c.enabled, providerLabel: c.providerLabel, writesEnabled: c.writesEnabled, whyOff: c.whyOff }))}
      destinations={destinations.map((d) => ({ channel: d.channel, address: d.address, label: d.label }))}
      canManage={canManage && !scope.readOnly}
      // Approval and test sends are decisions for someone in the client's own workspace.
      canApprove={canManage && actor.kind === "member"}
      canTestSend={canManage && actor.kind === "member"}
      canConfigure={actor.can("messaging.configure") && actor.kind === "member"}
      initialTab={tab}
    />
    </CustomValueTokensProvider>
  );
}
