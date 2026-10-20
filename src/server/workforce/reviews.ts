import "server-only";
import { withUser, type Queryable } from "@/server/db";
import { agentSettingsSchema, type AgentSettings } from "@/lib/agent-settings";
import { defaultSettings } from "@/server/workforce/compiler";
import {
  buildReviewDiff,
  classifyConfigChange,
  describeRiskCodes,
  decisionFromRiskFlags,
  redactReviewText,
  type ConfigOrgKind,
  type ConfigSource,
  type ReviewPayload,
  type ReviewReasonView,
  type ReviewVersionView,
} from "@/lib/config-review";
import { isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";

export interface HeldConfigRow {
  id: string;
  org_id: string;
  org_name: string;
  org_kind: string;
  agent_instance_id: string;
  role_key: string;
  agent_name: string;
  version: number;
  settings: AgentSettings;
  summary: string;
  source: string;
  risk_flags: string[];
  change_request: string | null;
  created_at: Date | string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_platform_role: string | null;
  created_by_org_role: string | null;
  previous_settings: AgentSettings | null;
}

const CONFIG_SOURCES: ConfigSource[] = ["onboarding", "client_edit", "change_request", "rollback", "agency"];

function configSource(value: string): ConfigSource {
  return CONFIG_SOURCES.includes(value as ConfigSource) ? (value as ConfigSource) : "client_edit";
}

function orgKind(value: string): ConfigOrgKind {
  return value === "agency" ? "agency" : "client";
}

function mergeReasons(computed: ReviewReasonView[], stored: ReviewReasonView[]): ReviewReasonView[] {
  const out: ReviewReasonView[] = [];
  const seen = new Set<string>();
  for (const reason of [...computed, ...stored]) {
    const key = reason.code;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

/**
 * Builds the review view for a stored held version. The current classifier is re-run so a reviewer
 * sees the latest severity and explanation, while codes stored by an older validator are retained
 * for audit and for legacy items such as the original Operations Manager v1.
 */
export function buildHeldConfigReview(row: HeldConfigRow): ReviewPayload {
  const next = agentSettingsSchema.parse(row.settings);
  const previousParsed = row.previous_settings ? agentSettingsSchema.safeParse(row.previous_settings) : null;
  const previous = previousParsed?.success ? previousParsed.data : null;
  const role: AgentRoleKey = isAgentRoleKey(row.role_key) ? row.role_key : "operations_manager";
  const source = configSource(row.source);
  const computed = classifyConfigChange({
    role,
    previous,
    next,
    source,
    actorKind: source === "agency" ? "agency" : "user",
    orgKind: orgKind(row.org_kind),
  });
  const stored = describeRiskCodes(row.risk_flags);
  const reasons = mergeReasons(computed.reasons.map((reason) => ({
    code: reason.code,
    label: reason.label,
    detail: reason.detail,
    severity: reason.severity,
    field: reason.field,
    match: reason.match ? redactReviewText(reason.match) : undefined,
  })), stored);
  const hasBlock = reasons.some((reason) => reason.severity === "block")
    || decisionFromRiskFlags(row.risk_flags) === "blocked";
  const reviewDecision = hasBlock
    ? "blocked"
    : reasons.length || decisionFromRiskFlags(row.risk_flags) === "review_required"
      ? "review_required"
      : "auto_apply";
  const legacy = row.risk_flags.length > 0 && computed.reasons.length === 0;
  return {
    decision: reviewDecision,
    severity: hasBlock ? "block" : "review",
    reasons,
    diff: buildReviewDiff(previous ?? defaultSettings(role), next),
    storedFlags: row.risk_flags,
    legacy,
    legacyNote: legacy
      ? "This version was held by an earlier validator. The current rules no longer flag this text, but the saved version is still waiting for a decision."
      : null,
  };
}

export function toReviewVersion(row: HeldConfigRow): ReviewVersionView {
  const role: AgentRoleKey = isAgentRoleKey(row.role_key) ? row.role_key : "operations_manager";
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    orgKind: orgKind(row.org_kind),
    agentRole: role,
    agentName: row.agent_name,
    version: row.version,
    source: row.source,
    summary: redactReviewText(row.summary),
    changeRequest: row.change_request ? redactReviewText(row.change_request) : null,
    submittedBy: row.created_by_name ?? "System",
    submittedByRole: row.created_by_platform_role && row.created_by_platform_role !== "none"
      ? row.created_by_platform_role.replaceAll("_", " ")
      : row.created_by_org_role,
    submittedAt: new Date(row.created_at).toISOString(),
    review: buildHeldConfigReview(row),
  };
}

const HELD_SELECT = `select v.id, v.org_id, o.name as org_name, o.kind as org_kind, v.agent_instance_id,
       a.role_key, a.display_name as agent_name, v.version, v.settings, v.summary, v.source, v.risk_flags, v.change_request,
       v.created_at, v.created_by, u.full_name as created_by_name,
       u.platform_role as created_by_platform_role, membership.role as created_by_org_role,
       previous.settings as previous_settings
from agent_config_versions v
join agent_instances a on a.id = v.agent_instance_id
join organizations o on o.id = v.org_id
left join users u on u.id = v.created_by
left join organization_memberships membership on membership.user_id = v.created_by and membership.org_id = v.org_id
left join lateral (
  select p.settings from agent_config_versions p
  where p.agent_instance_id = v.agent_instance_id and p.version < v.version and p.status = 'applied'
  order by p.version desc limit 1
) previous on true
where v.status = 'pending_agency_review'`;

/** Internal agency reviews only. Tenant scope is checked in SQL and in the caller's authorization. */
export async function listInternalHeldConfigReviews(userId: string): Promise<ReviewVersionView[]> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<HeldConfigRow>(
      `${HELD_SELECT} and o.kind = 'agency' and app.user_can_access_org($1, v.org_id) order by v.created_at`,
      [userId],
    );
    return rows.map(toReviewVersion);
  });
}

export async function countInternalHeldConfigReviews(userId: string): Promise<number> {
  const { rows } = await withUser(userId, async (db) =>
    db.query<{ n: number }>(
      `select count(*)::int as n from agent_config_versions v
       join organizations o on o.id = v.org_id
       where v.status = 'pending_agency_review' and o.kind = 'agency' and app.user_can_access_org($1, v.org_id)`,
      [userId],
    ),
  );
  return Number(rows[0]?.n ?? 0);
}

/** Shared query for the client-detail reviews tab. Authorization is done by getTenantDetail. */
export async function listHeldConfigReviewsForOrg(db: Queryable, orgId: string): Promise<ReviewVersionView[]> {
  const { rows } = await db.query<HeldConfigRow>(
    `${HELD_SELECT} and v.org_id = $1 order by v.created_at`,
    [orgId],
  );
  return rows.map(toReviewVersion);
}
