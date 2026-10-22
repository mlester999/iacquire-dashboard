import "server-only";
import { AppError } from "@/server/errors";
import type { CrmActor } from "@/server/crm/actor";
import { countConditions } from "@/lib/crm/filters";
import { DELEGABLE_PERMISSION_INFO, isDelegablePermission, type Permission } from "@/lib/permissions";
import { STEP_KINDS, type WorkflowDefinition } from "@/lib/crm/workflow/spec";

/**
 * A workflow runs as the workspace (its steps use a system actor), so it must never do more than the people who publish and switch it on
 * may do themselves. Each definition needs the CRM permissions its steps use; publishing it, switching it on and asking the owner to
 * approve it all require the person to hold every one of them ("Build and change automations" alone isn't enough to route leads to
 * yourself, change records you can't change, or have contact details sent to you). The publisher is recorded on the version.
 */

export interface PermissionNeed {
  permission: Permission;
  /** Why, in words ("the step "Route lead" assigns owners"). */
  why: string;
}

const hasPlaceholder = (v: unknown) => typeof v === "string" && v.includes("{{");
const TEXT_KEYS = ["title", "description", "body", "name"] as const;

export function permissionsNeeded(def: WorkflowDefinition): PermissionNeed[] {
  const out = new Map<Permission, string>();
  const need = (p: Permission, why: string) => {
    if (!out.has(p)) out.set(p, why);
  };
  const t = def.trigger ?? ({} as WorkflowDefinition["trigger"]);
  if (t.contactFilter && countConditions(t.contactFilter)) need("contacts.view", "its trigger checks contact details");
  if (t.type === "inbound_webhook" && t.inbound?.createContact) need("contacts.edit", "its trigger creates contacts");
  for (const s of Array.isArray(def.steps) ? def.steps : []) {
    const kind = String(s.kind);
    const c = (s.config ?? {}) as Record<string, unknown>;
    const label = `the step "${(s.name?.trim() || STEP_KINDS[s.kind as keyof typeof STEP_KINDS]?.label || kind).slice(0, 60)}"`;
    switch (kind) {
      case "add_tag":
      case "remove_tag":
        need("contacts.edit", `${label} changes contacts' tags`);
        break;
      case "assign":
        need("contacts.assign", `${label} assigns owners`);
        break;
      case "update_field":
        if (c.subject === "opportunity") need("opportunities.edit", `${label} changes deals`);
        else need("contacts.edit", `${label} changes contacts`);
        break;
      case "create_task":
        need("tasks.manage", `${label} creates tasks`);
        break;
      case "internal_note":
        need("notes.write", `${label} writes notes`);
        break;
      case "request_reassessment":
        need("contacts.view", `${label} asks for leads to be scored again`);
        break;
      case "set_priority":
        need("contacts.edit", `${label} changes leads' priority`);
        break;
      case "recovery_check":
        need("calls.view", `${label} looks at missed calls`);
        break;
      case "create_opportunity":
        need("opportunities.edit", `${label} creates deals`);
        if (c.ownerFromContact) need("contacts.assign", `${label} gives deals an owner`);
        break;
      case "move_stage":
        need("opportunities.edit", `${label} moves deals`);
        break;
      case "branch":
        if (c.subject === "opportunity") need("sales.view", `${label} checks deal details`);
        else need("contacts.view", `${label} checks contact details`);
        break;
      case "webhook":
        need("crm.api.manage", `${label} sends data to a webhook`);
        if (c.includeContact) need("contacts.view", `${label} sends contact details`);
        break;
      case "n8n":
        if (c.includeContact) need("contacts.view", `${label} sends contact details`);
        break;
      case "request_review":
        need("reviews.manage", `${label} requests reviews`);
        break;
      case "conversation_action":
        if (c.action === "assign_person" || c.action === "assign_contact_owner") need("inbox.assign", `${label} assigns conversations`);
        else need("inbox.reply", `${label} changes conversations`);
        break;
    }
    // Placeholders put contact details into text the team (or the publisher) reads: a notification, a task, a deal name or a note.
    if (TEXT_KEYS.some((k) => hasPlaceholder(c[k]))) need("contacts.view", `${label} fills in contact details`);
  }
  return [...out].map(([permission, why]) => ({ permission, why }));
}

const permissionLabel = (p: Permission) => (isDelegablePermission(p) ? DELEGABLE_PERMISSION_INFO[p].label : p === "crm.api.manage" ? "Manage API keys and webhooks" : p);

/**
 * Refuses when the actor lacks a permission the definition needs. `doing` is what they tried, for the message ("Publishing",
 * "Turning on", "Asking for approval of").
 */
export function assertMayRunDefinition(actor: CrmActor, def: WorkflowDefinition, doing: string) {
  const missing = permissionsNeeded(def).filter((n) => !actor.can(n.permission));
  if (!missing.length) return;
  const first = missing[0];
  const rest = missing.length > 1 ? ` (and ${missing.length - 1} more: ${missing.slice(1).map((m) => `“${permissionLabel(m.permission)}”`).join(", ")})` : "";
  throw new AppError(
    "forbidden",
    `${doing} this workflow needs the “${permissionLabel(first.permission)}” permission, because ${first.why}${rest}. A workflow can't do more than you can; ask the owner or a manager to do this, or to give you that access.`.slice(0, 600),
  );
}
