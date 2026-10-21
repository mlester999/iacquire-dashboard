import "server-only";
import type { z } from "zod";
import type { SessionUser } from "@/server/auth/service";
import type { Permission } from "@/lib/permissions";
import type { OpsApproval, OpsCard, OpsRisk, OpsScope, OpsScopeType } from "@/lib/aqi/ops/types";

/**
 * The shared tool declaration for AQi Operations. A tool is a *server* capability: it states who may
 * run it, where, with what arguments, how risky it is, whether it needs an approval, whether a retry
 * is safe and how it is audited. The model never sees a tool it is not entitled to and never supplies
 * anything that is not validated against `input`.
 */

export type OpsAgencyRole = "agency_staff" | "agency_manager" | "agency_super_admin";

export type OpsToolGroup =
  | "health" | "workspace" | "workforce" | "support" | "security" | "business"
  | "integrations" | "release" | "product" | "briefing" | "internal";

export interface OpsEvidenceInput {
  label: string;
  /** The system the data was read from. Shown to the administrator and recorded in the evidence list. */
  source: string;
  href?: string | null;
}

export interface OpsContext {
  user: SessionUser;
  scope: OpsScope;
  now: Date;
  signal: AbortSignal;
  requestId: string;
  /** Agency permissions the viewer holds right now, loaded once per turn from the database. */
  permissions: ReadonlySet<Permission>;
  /** Verifies that this viewer may access the tenant, caches the answer for the turn and records the access for auditing. */
  authorizeOrg(orgId: string, reason: string): Promise<void>;
}

export interface OpsReadOutput {
  /** Deterministic wording of what was found. Used verbatim when no model narrative is available. */
  summary: string;
  /** Structured findings handed to the model (redacted and bounded first). */
  data: unknown;
  cards: OpsCard[];
  evidence: OpsEvidenceInput;
  /** What could not be determined, and what would be needed to determine it. */
  unavailable?: string[];
  partial?: boolean;
}

interface ToolBase<S extends z.ZodType> {
  /** `group.name`, lowercase letters and dots only: it is also stored as an audit target. */
  id: string;
  title: string;
  /** One sentence for the planner catalogue and the capability list. */
  description: string;
  group: OpsToolGroup;
  /** Roles that may run it. Client roles never appear here. */
  roles: readonly OpsAgencyRole[];
  /** Agency permission the viewer must also hold, checked against the database (null = the role alone is enough). */
  permission: Permission | null;
  /** Scopes in which it can run. A tenant-only tool is refused in the platform scope. */
  scopes: readonly OpsScopeType[];
  input: S;
  risk: OpsRisk;
  approval: OpsApproval;
  /** Whether running it twice with the same input is harmless. Actions state how a duplicate is detected instead. */
  idempotent: boolean;
  audit: { action: string; sensitive: boolean };
  timeoutMs: number;
}

export interface OpsReadTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "read";
  risk: "read";
  approval: "none";
  run(ctx: OpsContext, args: z.infer<S>): Promise<OpsReadOutput>;
}

export interface OpsActionPreview {
  headline: string;
  /** Exactly what will change, one fact per line. */
  effects: string[];
  target: string;
  reversible: string;
  /** Tenant the action touches, when it touches one. */
  orgId: string | null;
  /** Text to type for typed confirmation (usually the target's name). */
  confirmPhrase?: string;
}

export interface OpsActionTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "action";
  risk: Exclude<OpsRisk, "read">;
  approval: Exclude<OpsApproval, "none">;
  /** Read-only: validates the target exists and is in a state where the action makes sense. Throws an AppError otherwise. */
  preview(ctx: OpsContext, args: z.infer<S>): Promise<OpsActionPreview>;
  /** Calls the existing domain function. Runs only after a confirmed, unexpired, unclaimed proposal. */
  execute(ctx: OpsContext, args: z.infer<S>, meta: { actionId: string; reason: string | null }): Promise<Record<string, unknown>>;
  /** Re-reads the system and states whether the intended end state is actually true. */
  verify(ctx: OpsContext, args: z.infer<S>, executed: Record<string, unknown>): Promise<{ verified: boolean; observed: string[] }>;
}

export type OpsTool = OpsReadTool<z.ZodType> | OpsActionTool<z.ZodType>;

export function defineReadTool<S extends z.ZodType>(tool: Omit<OpsReadTool<S>, "kind" | "risk" | "approval">): OpsReadTool<S> {
  return { ...tool, kind: "read", risk: "read", approval: "none" };
}

export function defineActionTool<S extends z.ZodType>(tool: Omit<OpsActionTool<S>, "kind">): OpsActionTool<S> {
  return { ...tool, kind: "action" };
}
