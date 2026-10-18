import "server-only";
import { CHECK_LABEL, type CheckKey } from "@/lib/setup";

/**
 * Typed seam for the future automated provisioning engine.
 *
 * Two halves, deliberately separate:
 *   - Connectors (connectors.ts) PROVE an integration works right now.
 *   - Provisioning adapters (this file) DO the work: create, install, configure.
 *
 * A provisioning job that has started is never evidence of success. A step only completes when its
 * connector verifies the result. None of these adapters is implemented yet, so each one reports
 * `not_available` instead of pretending, and the Setup Center shows the step as needing the agency.
 *
 * When one is built it must stay inside these limits: tenant-scoped (never accept a location ID from
 * a client), idempotent, never activate GoHighLevel workflows, n8n automation or outbound messaging
 * without an explicit authorization step, and never touch the protected Aster Homes location or the
 * agency's own internal environment.
 */
export type ProvisioningStepKey =
  | "ghl_subaccount_mapping"
  | "crm_snapshot"
  | "crm_assets"
  | "hermes_employees"
  | "n8n_workflows"
  | "calendar"
  | "email_domain"
  | "website_funnel"
  | "final_health_check";

export interface ProvisioningRequest {
  orgId: string;
  requestedBy: string | null;
  /** The same key must never start the same work twice. */
  idempotencyKey: string;
}

export type ProvisioningOutcome =
  | { state: "not_available"; reason: string }
  | { state: "accepted"; jobRef: string }
  | { state: "failed"; reason: string };

export interface ProvisioningAdapter {
  key: ProvisioningStepKey;
  label: string;
  /** The connector whose passing result is the only thing that completes the matching step. */
  verifiedBy: CheckKey;
  implemented: boolean;
  unavailableReason: string;
  start(request: ProvisioningRequest): Promise<ProvisioningOutcome>;
}

function pending(key: ProvisioningStepKey, label: string, verifiedBy: CheckKey, reason: string): ProvisioningAdapter {
  return {
    key,
    label,
    verifiedBy,
    implemented: false,
    unavailableReason: reason,
    start: async () => ({ state: "not_available", reason }),
  };
}

export const PROVISIONERS: Record<ProvisioningStepKey, ProvisioningAdapter> = {
  ghl_subaccount_mapping: pending("ghl_subaccount_mapping", "GoHighLevel sub-account mapping and snapshot verification", "ghl_location", "Sub-accounts are created in GoHighLevel by the team and mapped here by an admin. There is no automatic creation yet."),
  // Native CRM: a super admin previews and applies a published Blueprint version from the agency library (src/server/crm/blueprints/apply.ts,
  // which needs a confirmed plan digest), so this adapter never applies one by itself. The crm_snapshot and crm_assets connectors verify
  // the result from the workspace's own rows. GoHighLevel workspaces: snapshots are still installed in GoHighLevel and can't be inspected.
  crm_snapshot: pending("crm_snapshot", "CRM Blueprint (or GoHighLevel snapshot) installation", "crm_snapshot", "Native CRM Blueprints are applied by a super admin after a preview in CRM Blueprints; GoHighLevel snapshots are installed in GoHighLevel by the team. This adapter starts neither on its own."),
  crm_assets: pending("crm_assets", "CRM pipelines, tags, custom fields and forms", "crm_assets", "CRM assets come from the applied Blueprint and the team's tailoring. The check compares the Blueprint's expected records with the workspace; nothing is created here."),
  hermes_employees: pending("hermes_employees", "Hermes AI employee profiles", "hermes_employees", "Hermes profiles are created on the VPS from the runbook. The portal never touches the Hermes host; it only health-checks the result."),
  n8n_workflows: pending("n8n_workflows", "n8n workflow setup", "workflows", "Workflows are built and approved by the team. The portal never activates or edits n8n workflows."),
  calendar: pending("calendar", "Calendar connection", "calendar", "Each host connects their own calendar (CRM → Calendar Connections) or the client uses the iAcquire calendar only. The calendar check verifies the result; nothing is connected on the client's behalf."),
  email_domain: pending("email_domain", "Email domain verification", "email_domain", "DNS records are added by the client and the team. Domain verification isn't connected yet."),
  website_funnel: pending("website_funnel", "Website and funnel provisioning", "website_live", "Websites are built and published by the team. Publishing and domain checks aren't automated yet."),
  final_health_check: pending("final_health_check", "Final health checks", "final_health", "The final check aggregates the other checks. It is a verification, not something provisioned."),
};

export const provisioningLabel = (key: CheckKey) => CHECK_LABEL[key];
