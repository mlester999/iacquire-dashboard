import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import type { AgentMode } from "@/server/automation/gate";

export const AGENT_MODES: readonly AgentMode[] = ["autonomous", "approval_required", "paused"];
export const isAgentMode = (value: unknown): value is AgentMode => typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);

export type ClientPauseScope = "messaging" | "outbound";

export interface ControlState {
  pauses: Record<"messaging" | "outbound" | "agency", { active: boolean; reason: string | null; setAt: string | null }>;
  employees: Array<{ id: string; roleKey: string; displayName: string; mode: AgentMode; enabled: boolean; status: string }>;
}

export async function getControlState(db: Queryable, orgId: string): Promise<ControlState> {
  const { rows: pauses } = await db.query<{ scope: "messaging" | "outbound" | "agency"; active: boolean; reason: string | null; set_at: Date | null }>(
    "select scope, active, reason, set_at from automation_pauses where org_id = $1",
    [orgId],
  );
  const { rows: agents } = await db.query<{ id: string; role_key: string; display_name: string; mode: AgentMode; enabled: boolean; status: string }>(
    `select a.id, a.role_key, a.display_name, a.mode, a.enabled, a.status from agent_instances a
     join agent_roles r on r.key = a.role_key where a.org_id = $1 order by r.sort_order`,
    [orgId],
  );
  const state: ControlState["pauses"] = {
    messaging: { active: false, reason: null, setAt: null },
    outbound: { active: false, reason: null, setAt: null },
    agency: { active: false, reason: null, setAt: null },
  };
  for (const p of pauses) state[p.scope] = { active: p.active, reason: p.reason, setAt: p.set_at ? new Date(p.set_at).toISOString() : null };
  return {
    pauses: state,
    employees: agents.map((a) => ({ id: a.id, roleKey: a.role_key, displayName: a.display_name, mode: a.mode, enabled: a.enabled, status: a.status })),
  };
}

const trimReason = (reason?: string) => (reason ?? "").trim().slice(0, 500);

/**
 * Change one employee's operating mode.
 * Pausing and requiring approval are the safe directions and need `automation.pause`.
 * Autonomous needs the owner, an explicit confirmation, a passed health check and an activated
 * workspace; it is never the result of creating a profile.
 */
export async function setAgentMode(ctx: OrgContext, input: { agentId: string; mode: AgentMode; reason?: string; confirmAutonomous?: boolean }) {
  if (!isAgentMode(input.mode)) throw new AppError("invalid_input", "Choose a valid operating mode.");
  if (!ctx.can("automation.pause")) throw new AppError("forbidden", "Only owners and managers can change how an employee operates.");
  if (input.mode === "autonomous" && !ctx.can("automation.go_autonomous")) {
    throw new AppError("forbidden", "Only the business owner can let an employee work without approval.");
  }
  const reason = trimReason(input.reason);
  return withSystem(async (db) => {
    // The org id comes from the verified session, never from the request.
    const { rows } = await db.query<{ id: string; role_key: string; display_name: string; enabled: boolean; status: string; mode: AgentMode; last_health_ok: boolean | null }>(
      "select id, role_key, display_name, enabled, status, mode, last_health_ok from agent_instances where id = $1 and org_id = $2 for update",
      [input.agentId, ctx.org.orgId],
    );
    const agent = rows[0];
    if (!agent) throw new AppError("not_found", "Employee not found.");
    if (agent.mode === input.mode) return { mode: agent.mode, changed: false };
    if (input.mode === "autonomous") await assertCanGoAutonomous(db, ctx.org.orgId, agent, input.confirmAutonomous === true);
    await db.query(
      "update agent_instances set mode = $2, mode_changed_by = $3, mode_changed_at = now(), mode_reason = nullif($4, '') where id = $1",
      [agent.id, input.mode, ctx.user.id, reason],
    );
    await recordAudit(
      {
        orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", agentInstanceId: agent.id, action: "agent.mode_changed",
        targetType: "agent_instance", targetId: agent.id, result: "success", metadata: { from: agent.mode, to: input.mode, role: agent.role_key, reason },
      },
      db,
    );
    if (input.mode === "paused" || input.mode === "autonomous") {
      await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], {
        kind: "agent_status",
        severity: input.mode === "paused" ? "warning" : "info",
        title: `${agent.display_name} is now ${input.mode === "paused" ? "paused" : "working autonomously"}`,
        body: input.mode === "paused" ? "It will not start new work or contact customers until resumed." : "It can carry out low-risk approved work without asking each time.",
        link: "/workforce",
      });
    }
    return { mode: input.mode, changed: true };
  });
}

/** Why this employee cannot work autonomously yet, in words a client can act on. Null when it can. */
export async function autonomousBlocker(
  db: Queryable,
  orgId: string,
  agent: { enabled: boolean; status: string; last_health_ok: boolean | null; display_name: string },
): Promise<string | null> {
  if (!agent.enabled) return `${agent.display_name} is not included in your workspace.`;
  if (!["online", "busy"].includes(agent.status) || agent.last_health_ok !== true) {
    return `${agent.display_name} must pass its connection check before it can work autonomously.`;
  }
  const { rows } = await db.query<{ state: string }>("select state from client_setup_instances where org_id = $1", [orgId]);
  if (rows[0]?.state !== "activated") return "Autonomous work unlocks after iAcquire activates your workspace and every required check has passed.";
  const { rows: pause } = await db.query(
    "select 1 from automation_pauses p join organizations o on o.id = p.org_id where p.active and p.scope = 'agency' and (p.org_id = $1 or o.kind = 'agency')",
    [orgId],
  );
  return pause.length ? "iAcquire has paused automation for this workspace, so autonomous mode is unavailable right now." : null;
}

async function assertCanGoAutonomous(
  db: Queryable,
  orgId: string,
  agent: { enabled: boolean; status: string; last_health_ok: boolean | null; display_name: string },
  confirmed: boolean,
) {
  if (!confirmed) throw new AppError("invalid_input", "Confirm that this employee may work without asking for each action.");
  const blocker = await autonomousBlocker(db, orgId, agent);
  if (blocker) throw new AppError("conflict", blocker);
}

/** Pause or resume all customer-facing AI messaging, or all outbound actions, for the client. */
export async function setClientPause(ctx: OrgContext, input: { scope: ClientPauseScope; paused: boolean; reason?: string }) {
  if (!ctx.can("automation.pause")) throw new AppError("forbidden", "Only owners and managers can pause automation.");
  if (input.scope !== "messaging" && input.scope !== "outbound") throw new AppError("invalid_input", "Unknown pause type.");
  const reason = trimReason(input.reason);
  return withSystem(async (db) => {
    await db.query(
      `insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, $2, $3, nullif($4, ''), $5, now())
       on conflict (org_id, scope) do update set active = excluded.active, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
      [ctx.org.orgId, input.scope, input.paused, reason, ctx.user.id],
    );
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: input.paused ? "automation.paused" : "automation.resumed", targetType: "automation_pause", targetId: input.scope, result: "success", metadata: { scope: input.scope, reason } },
      db,
    );
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], {
      kind: "agent_status",
      severity: input.paused ? "warning" : "info",
      title: input.paused ? (input.scope === "messaging" ? "Customer-facing AI messaging paused" : "Outbound AI actions paused") : "AI automation resumed",
      body: input.paused ? "Queued sends are blocked until it is resumed." : undefined,
      link: "/workforce",
    });
    return getControlState(db, ctx.org.orgId);
  });
}

/**
 * Agency emergency pause. Any assigned agency user can stop a client; only a super admin can lift it,
 * so a stop cannot be quietly undone. `orgId = null` is the platform-wide pause (super admin only).
 * The reason is kept in the audit log, not in a client-readable column.
 */
export async function setAgencyPause(user: Pick<SessionUser, "id" | "platformRole">, input: { orgId: string | null; paused: boolean; reason: string }) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  const isSuper = user.platformRole === "agency_super_admin";
  if (!isSuper && (input.orgId === null || !input.paused)) {
    throw new AppError("forbidden", input.orgId === null ? "Only a super admin can pause the whole platform." : "Only a super admin can lift an emergency pause.");
  }
  const reason = trimReason(input.reason);
  if (input.paused && !reason) throw new AppError("invalid_input", "Record why automation is being paused.");
  return withSystem(async (db) => {
    let target = input.orgId;
    if (target === null) {
      const { rows } = await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1");
      target = rows[0]?.id ?? null;
      if (!target) throw new AppError("not_found", "Agency workspace not found.");
    } else {
      const { rows } = await db.query<{ kind: string }>("select kind from organizations where id = $1", [target]);
      if (!rows[0]) throw new AppError("not_found", "Workspace not found.");
      if (!isSuper) {
        const assigned = await db.query("select 1 from staff_assignments where org_id = $1 and user_id = $2", [target, user.id]);
        if (!assigned.rows.length) throw new AppError("forbidden", "You are not assigned to this client.");
      }
    }
    await db.query(
      `insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'agency', $2, null, $3, now())
       on conflict (org_id, scope) do update set active = excluded.active, set_by = excluded.set_by, set_at = excluded.set_at`,
      [target, input.paused, user.id],
    );
    await recordAudit(
      { orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: input.paused ? "automation.agency_paused" : "automation.agency_resumed", targetType: "automation_pause", targetId: input.orgId ?? "platform", result: "success", metadata: { platformWide: input.orgId === null, reason } },
      db,
    );
    if (input.orgId) {
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
        kind: "agent_status",
        severity: input.paused ? "critical" : "info",
        title: input.paused ? "iAcquire paused automation for your workspace" : "iAcquire resumed automation for your workspace",
        body: input.paused ? "Customer messages and new autonomous work are on hold. Private chat with your employees still works. Our team will contact you." : undefined,
        link: "/workforce",
      });
    }
    return { paused: input.paused };
  });
}
