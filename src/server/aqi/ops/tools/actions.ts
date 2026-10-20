import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { acknowledgeIncident } from "@/server/ops/incidents";
import { changePriority, escalateRequest } from "@/server/support/agency";
import { submitRequest } from "@/server/support/service";
import { setAgencyPause } from "@/server/automation/controls";
import { buildContext, type Membership } from "@/server/tenancy/context";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";
import { defineActionTool } from "@/server/aqi/ops/tool";
import { clean } from "@/server/aqi/ops/tools/helpers";

/**
 * The write tools. None of them runs inside a chat turn: a turn can only *propose* one (see
 * actions.ts). Each calls the existing domain function, so lifecycle rules, notifications, audit
 * and permission checks of that module apply unchanged, and then re-reads the system to verify.
 */

const SUPER = ["agency_super_admin"] as const;
const uuid = z.string().uuid();

export const incidentAcknowledge = defineActionTool({
  id: "incident.acknowledge",
  title: "Acknowledge incident",
  description: "Marks an open incident as acknowledged by the administrator.",
  group: "health",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["incident"],
  input: z.object({ incidentId: uuid }).strict(),
  risk: "low",
  approval: "confirm",
  idempotent: true,
  audit: { action: "aqi.ops_action", sensitive: false },
  timeoutMs: 10_000,
  async preview(ctx, args) {
    // The target is the record selected as the context: arguments never choose a different one.
    if (ctx.scope.type !== "incident" || ctx.scope.id !== args.incidentId) throw new AppError("forbidden", "The incident must be the one selected as the context.");
    const { rows } = await readSystem((db) => db.query<{ id: string; status: string; severity: string; title: string; org_id: string | null; org: string | null }>(
      "select i.id, i.status, i.severity, i.title, i.org_id, o.name as org from incidents i left join organizations o on o.id = i.org_id where i.id = $1", [args.incidentId],
    ));
    const incident = rows[0];
    if (!incident) throw new AppError("not_found", "Incident not found.");
    if (incident.org_id) await ctx.authorizeOrg(incident.org_id, "action:incident.acknowledge");
    if (incident.status !== "open") throw new AppError("conflict", `This incident is already ${incident.status}.`);
    return {
      headline: `Acknowledge the ${incident.severity} incident “${clean(incident.title, 100)}”`,
      effects: [
        "Marks the incident as acknowledged by you and adds an entry to its timeline.",
        "Does not fix the underlying condition: it stays open until a later healthy check or a manual resolution.",
        "Stops further unacknowledged-incident escalation reminders for this incident.",
      ],
      target: clean(incident.title, 120),
      reversible: "Not reversible. You can still add a note or resolve the incident afterwards.",
      orgId: incident.org_id,
    };
  },
  async execute(ctx, args) {
    await acknowledgeIncident(ctx.user, args.incidentId);
    return { incidentId: args.incidentId };
  },
  async verify(ctx, args) {
    const { rows } = await readSystem((db) => db.query<{ status: string; acknowledged_by: string | null }>("select status, acknowledged_by from incidents where id = $1", [args.incidentId]));
    const row = rows[0];
    const ok = Boolean(row) && ["acknowledged", "resolved"].includes(row.status) && (row.status === "resolved" || row.acknowledged_by === ctx.user.id);
    return { verified: ok, observed: [row ? `Incident status is now ${row.status}${row.acknowledged_by === ctx.user.id ? ", acknowledged by you" : ""}.` : "The incident could not be read back."] };
  },
});

export const supportEscalate = defineActionTool({
  id: "support.escalate",
  title: "Escalate support request",
  description: "Flags an active support request as escalated and tells the agency managers for that client.",
  group: "support",
  roles: SUPER,
  permission: "agency.support.manage",
  scopes: ["ticket"],
  input: z.object({ ticketId: uuid, reason: z.string().trim().min(3).max(300) }).strict(),
  risk: "medium",
  approval: "confirm_with_reason",
  idempotent: true,
  audit: { action: "aqi.ops_action", sensitive: false },
  timeoutMs: 12_000,
  async preview(ctx, args) {
    if (ctx.scope.type !== "ticket" || ctx.scope.id !== args.ticketId) throw new AppError("forbidden", "The request must be the one selected as the context.");
    const { rows } = await readSystem((db) => db.query<{ id: string; ref: string; subject: string; status: string; org_id: string; org: string; escalated_at: Date | null }>(
      `select t.id, t.ref, t.subject, t.status, t.org_id, o.name as org, p.escalated_at
         from support_tickets t join organizations o on o.id = t.org_id left join support_ticket_ops p on p.ticket_id = t.id where t.id = $1`, [args.ticketId],
    ));
    const t = rows[0];
    if (!t) throw new AppError("not_found", "Support request not found.");
    await ctx.authorizeOrg(t.org_id, "action:support.escalate");
    if (["resolved", "closed"].includes(t.status)) throw new AppError("conflict", "Only an active request can be escalated.");
    if (t.escalated_at) throw new AppError("conflict", `${t.ref} is already escalated.`);
    return {
      headline: `Escalate ${t.ref}: ${clean(t.subject, 90)}`,
      effects: [
        `Flags ${t.ref} for ${clean(t.org, 60)} as escalated with your reason: “${clean(args.reason, 200)}”.`,
        "Agency managers for this client receive a critical in-app notification.",
        "The escalation is internal: the client is not told.",
      ],
      target: `${t.ref} (${clean(t.org, 60)})`,
      reversible: "Yes. An escalation can be cleared from the request in Support & Requests.",
      orgId: t.org_id,
    };
  },
  async execute(ctx, args) {
    await escalateRequest(ctx.user, args.ticketId, args.reason);
    return { ticketId: args.ticketId };
  },
  async verify(_ctx, args) {
    const { rows } = await readSystem((db) => db.query<{ escalated_at: Date | null }>("select escalated_at from support_ticket_ops where ticket_id = $1", [args.ticketId]));
    return { verified: Boolean(rows[0]?.escalated_at), observed: [rows[0]?.escalated_at ? "The request is now flagged as escalated." : "The request is not flagged as escalated."] };
  },
});

export const supportSetPriority = defineActionTool({
  id: "support.set_priority",
  title: "Change support priority",
  description: "Changes the team priority of a support request and recomputes its response target.",
  group: "support",
  roles: SUPER,
  permission: "agency.support.priority",
  scopes: ["ticket"],
  input: z.object({ ticketId: uuid, priority: z.enum(["low", "normal", "high", "urgent"]), reason: z.string().trim().max(300).default("") }).strict(),
  risk: "medium",
  approval: "confirm",
  idempotent: true,
  audit: { action: "aqi.ops_action", sensitive: false },
  timeoutMs: 12_000,
  async preview(ctx, args) {
    if (ctx.scope.type !== "ticket" || ctx.scope.id !== args.ticketId) throw new AppError("forbidden", "The request must be the one selected as the context.");
    const { rows } = await readSystem((db) => db.query<{ ref: string; subject: string; priority: string; status: string; org_id: string; org: string }>(
      "select t.ref, t.subject, t.priority, t.status, t.org_id, o.name as org from support_tickets t join organizations o on o.id = t.org_id where t.id = $1", [args.ticketId],
    ));
    const t = rows[0];
    if (!t) throw new AppError("not_found", "Support request not found.");
    await ctx.authorizeOrg(t.org_id, "action:support.set_priority");
    if (t.priority === args.priority) throw new AppError("conflict", `${t.ref} is already ${t.priority} priority.`);
    return {
      headline: `Change ${t.ref} from ${t.priority} to ${args.priority} priority`,
      effects: [
        `Sets the team priority of ${t.ref} (${clean(t.org, 60)}) to ${args.priority}.`,
        "Recomputes the response-time target from the support settings.",
        "Raising a request to high or urgent can notify agency managers; the client is not told.",
      ],
      target: `${t.ref} (${clean(t.org, 60)})`,
      reversible: "Yes. Priority can be changed again at any time.",
      orgId: t.org_id,
    };
  },
  async execute(ctx, args) {
    await changePriority(ctx.user, args.ticketId, args.priority, args.reason || undefined);
    return { ticketId: args.ticketId };
  },
  async verify(_ctx, args) {
    const { rows } = await readSystem((db) => db.query<{ priority: string }>("select priority from support_tickets where id = $1", [args.ticketId]));
    return { verified: rows[0]?.priority === args.priority, observed: [`Priority is now ${rows[0]?.priority ?? "unknown"}.`] };
  },
});

export const automationAgencyPause = defineActionTool({
  id: "automation.agency_pause",
  title: "Pause or resume client automation",
  description: "Applies or lifts the agency emergency pause for one client workspace.",
  group: "workforce",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["tenant", "employee", "workflow", "ticket"],
  input: z.object({ orgId: uuid, paused: z.boolean(), reason: z.string().trim().min(3).max(300) }).strict(),
  risk: "high",
  approval: "typed_confirmation",
  idempotent: true,
  audit: { action: "aqi.ops_action", sensitive: true },
  timeoutMs: 12_000,
  async preview(ctx, args) {
    if (ctx.scope.orgId !== args.orgId) throw new AppError("forbidden", "The pause target must be the selected client workspace.");
    await ctx.authorizeOrg(args.orgId, "action:automation.agency_pause");
    const { rows } = await readSystem((db) => db.query<{ name: string; kind: string; active: boolean | null }>(
      `select o.name, o.kind, (select p.active from automation_pauses p where p.org_id = o.id and p.scope = 'agency') as active from organizations o where o.id = $1`, [args.orgId],
    ));
    const org = rows[0];
    if (!org) throw new AppError("not_found", "Workspace not found.");
    if (org.kind !== "client") throw new AppError("conflict", "Only a client workspace can be paused from here.");
    const current = org.active === true;
    if (current === args.paused) throw new AppError("conflict", `Automation for ${org.name} is already ${current ? "paused" : "running"}.`);
    return {
      headline: `${args.paused ? "Pause" : "Resume"} all automation for ${clean(org.name, 80)}`,
      effects: args.paused
        ? [
            `Applies the agency emergency pause to ${clean(org.name, 80)}: customer-facing messages and new autonomous AI work are held.`,
            "Business owners and managers of this client receive an in-app notice that iAcquire paused automation.",
            "Private chat with the client's AI employees keeps working.",
            `Your reason is stored in the audit log: “${clean(args.reason, 200)}”.`,
          ]
        : [
            `Lifts the agency emergency pause for ${clean(org.name, 80)}; held automation can proceed again.`,
            "Business owners and managers of this client receive an in-app notice that automation resumed.",
          ],
      target: clean(org.name, 80),
      reversible: args.paused ? "Yes. A Super Admin can resume automation with the same action." : "Yes. It can be paused again.",
      orgId: args.orgId,
      confirmPhrase: clean(org.name, 60),
    };
  },
  async execute(ctx, args) {
    await setAgencyPause(ctx.user, { orgId: args.orgId, paused: args.paused, reason: args.reason });
    return { orgId: args.orgId, paused: args.paused };
  },
  async verify(_ctx, args) {
    const { rows } = await readSystem((db) => db.query<{ active: boolean }>("select active from automation_pauses where org_id = $1 and scope = 'agency'", [args.orgId]));
    const active = rows[0]?.active === true;
    return { verified: active === args.paused, observed: [`The agency pause is now ${active ? "active" : "not active"} for this workspace.`] };
  },
});

const ISSUE_PREFIX = { internal_issue: "[Internal]", platform_bug: "[Platform bug]", engineering_task: "[Proposed engineering task]" } as const;

export const issueCreate = defineActionTool({
  id: "issue.create",
  title: "Create internal issue",
  description: "Records an internal issue, platform bug or proposed engineering task as a request in Support & Requests under the agency workspace. Nothing is executed.",
  group: "internal",
  roles: SUPER,
  permission: "agency.support.queue",
  scopes: ["platform", "tenant", "employee", "workflow", "ticket", "incident"],
  input: z.object({
    kind: z.enum(["internal_issue", "platform_bug", "engineering_task"]),
    subject: z.string().trim().min(3).max(120),
    details: z.string().trim().min(5).max(1500),
  }).strict(),
  risk: "medium",
  approval: "confirm",
  idempotent: true,
  audit: { action: "aqi.ops_action", sensitive: false },
  timeoutMs: 15_000,
  async preview(_ctx, args) {
    return {
      headline: `Create ${args.kind === "engineering_task" ? "a proposed engineering task" : args.kind === "platform_bug" ? "a platform bug record" : "an internal issue"}: ${clean(args.subject, 100)}`,
      effects: [
        `Creates one request titled “${ISSUE_PREFIX[args.kind]} ${clean(args.subject, 100)}” in Support & Requests under the agency workspace (type: issue report).`,
        "Agency staff are notified through the normal Support & Requests notification rules.",
        "No client is contacted and nothing is built or deployed: an engineering task is only a proposal until a person reviews and accepts it.",
      ],
      target: "Support & Requests (agency workspace)",
      reversible: "Yes. The request can be closed from Support & Requests.",
      orgId: null,
    };
  },
  async execute(ctx, args, meta) {
    const workspace = await ensureAgencyWorkspace(ctx.user);
    if (!workspace) throw new AppError("not_found", "The agency workspace is not available.");
    const membership: Membership = {
      orgId: workspace.orgId, name: workspace.name, slug: workspace.slug, kind: "agency", status: "active", role: "owner",
      isDemo: false, onboardingCompletedAt: null, timezone: workspace.timezone,
    };
    const orgCtx = buildContext(ctx.user, membership, [membership]);
    const result = await submitRequest(orgCtx, {
      requestType: "issue",
      subject: `${ISSUE_PREFIX[args.kind]} ${args.subject}`.slice(0, 160),
      message: `${args.details}\n\nRecorded from AQi Operations (${args.kind.replace("_", " ")}) after administrator confirmation. Action ${meta.actionId}.`,
      category: args.kind === "platform_bug" ? "feature_not_working" : "other",
      idempotencyKey: `aqi-ops-${meta.actionId}`,
    });
    return { ticketId: result.id, ref: result.ref, existing: result.existing };
  },
  async verify(_ctx, _args, executed) {
    const ticketId = String(executed.ticketId ?? "");
    const { rows } = await readSystem((db) => db.query<{ ref: string; status: string; kind: string }>(
      "select t.ref, t.status, o.kind from support_tickets t join organizations o on o.id = t.org_id where t.id = $1", [ticketId],
    ));
    const row = rows[0];
    return { verified: Boolean(row) && row.kind === "agency", observed: [row ? `${row.ref} exists in Support & Requests with status ${row.status}.` : "The request could not be read back."] };
  },
});

export const ACTION_TOOLS = [incidentAcknowledge, supportEscalate, supportSetPriority, automationAgencyPause, issueCreate];
