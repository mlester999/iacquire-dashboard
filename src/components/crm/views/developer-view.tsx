import { env } from "@/server/env";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { API_SCOPES, KEY_EXPIRY_CHOICES, listApiKeys, MAX_ACTIVE_KEYS } from "@/server/crm/api-keys";
import { AUTO_DISABLE_AFTER, listWebhookSubscriptions, MAX_SUBSCRIPTIONS, WEBHOOK_API_VERSION, WEBHOOK_EVENTS } from "@/server/crm/webhooks";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { DeveloperSettings } from "@/components/crm/developer/developer-settings";

/**
 * CRM Settings → API & Webhooks (/crm/settings/api). Owners and managers (crm.api.manage) create scoped API keys and signed webhook
 * subscriptions. Secrets are never read back here: keys exist only as hashes and signing secrets are shown once when created or rolled.
 */
export async function DeveloperView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [keys, subscriptions] = await Promise.all([listApiKeys(actor), listWebhookSubscriptions(actor)]);
  await auditSupportView(actor, "api-webhooks");
  const apiBase = `${env().APP_URL.replace(/\/+$/, "")}/api/v1/crm`;
  return (
    <DeveloperSettings
      scope={scope}
      keys={keys}
      subscriptions={subscriptions}
      scopes={API_SCOPES.map((s) => ({ scope: s.scope, label: s.label, description: s.description }))}
      events={WEBHOOK_EVENTS.map((e) => ({ type: e.type, group: e.group, label: e.label }))}
      apiBase={apiBase}
      apiVersion={WEBHOOK_API_VERSION}
      limits={{ maxKeys: MAX_ACTIVE_KEYS, maxSubscriptions: MAX_SUBSCRIPTIONS, autoDisableAfter: AUTO_DISABLE_AFTER, requestsPerMinute: RATE_LIMITS.crmApiByKey.limit, expiryChoices: [...KEY_EXPIRY_CHOICES] }}
      canManage={actor.kind === "member" && actor.can("crm.api.manage") && !scope.readOnly}
    />
  );
}
