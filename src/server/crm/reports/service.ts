import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { buildScope, type ReportScope } from "@/server/crm/reports/scope";
import { leadsSection } from "@/server/crm/reports/leads";
import { appointmentsSection } from "@/server/crm/reports/appointments";
import { dealsSection, pipelineSection } from "@/server/crm/reports/deals";
import { followUpsSection, messagingSection } from "@/server/crm/reports/messaging";
import { aiSection, integrationsSection, usageSection, workflowsSection, workloadSection } from "@/server/crm/reports/operations";
import {
  CHANNEL_LABELS, REPORT_SECTIONS, SECTION_INFO, customRangeIssue, ignoredFilters, reportFiltersSchema, todayIn,
  type FilterKey, type ReportFilters, type ReportSection,
} from "@/components/crm/reports/spec";
import type { CrmReport, ReportOptions, SectionResult } from "@/components/crm/reports/types";
import { CREATED_VIA_LABELS } from "@/lib/crm/types";
import { DELEGABLE_PERMISSION_INFO, isDelegablePermission } from "@/lib/permissions";

const COMPUTE: { [S in ReportSection]: (scope: ReportScope) => Promise<SectionResult<S>> } = {
  leads: leadsSection,
  appointments: appointmentsSection,
  deals: dealsSection,
  pipeline: pipelineSection,
  messaging: messagingSection,
  followups: followUpsSection,
  workload: workloadSection,
  ai: aiSection,
  workflows: workflowsSection,
  integrations: integrationsSection,
  usage: usageSection,
};

/** Why someone can't see a section, naming the permission the way Team & Permissions does. */
export function hiddenReason(actor: CrmActor, section: ReportSection): string | null {
  const missing = SECTION_INFO[section].needs.filter((p) => !actor.can(p));
  if (!missing.length) return null;
  if (actor.kind === "agency") return "Not part of a support session.";
  const named = missing.find(isDelegablePermission);
  return named ? `Needs the “${DELEGABLE_PERMISSION_INFO[named].label}” permission.` : "Not available for your role.";
}

/**
 * Checks the filters against this workspace: a team member must be an active member, a pipeline a live native pipeline, a campaign one of
 * this workspace's campaigns. Anything else is dropped with a notice, so a stale link or saved report still opens and never silently shows
 * another filter's numbers.
 */
async function checkFilters(actor: CrmActor, filters: ReportFilters): Promise<{ filters: ReportFilters; labels: Partial<Record<FilterKey, string>>; notices: string[] }> {
  const out: ReportFilters = { ...filters };
  const labels: Partial<Record<FilterKey, string>> = {};
  const notices: string[] = [];
  // Trusted lookups by id, always scoped to the actor's own organization.
  await withSystem(async (db) => {
    if (out.member) {
      const { rows } = await db.query<{ name: string }>(
        "select coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id = $2 and m.status = 'active'",
        [actor.orgId, out.member],
      );
      if (rows[0]) labels.member = rows[0].name;
      else {
        delete out.member;
        notices.push("The chosen team member isn't an active member of this workspace, so that filter was removed.");
      }
    }
    if (out.pipeline) {
      const { rows } = await db.query<{ name: string }>("select name from crm_pipelines where org_id = $1 and id = $2 and provider = 'native' and archived_at is null", [actor.orgId, out.pipeline]);
      if (rows[0]) labels.pipeline = rows[0].name;
      else {
        delete out.pipeline;
        notices.push("The chosen pipeline no longer exists, so that filter was removed.");
      }
    }
    if (out.campaign) {
      const { rows } = await db.query<{ name: string }>("select name from crm_campaigns where org_id = $1 and id = $2", [actor.orgId, out.campaign]);
      if (rows[0] && actor.can("campaigns.manage")) labels.campaign = rows[0].name;
      else if (!rows[0]) {
        delete out.campaign;
        notices.push("The chosen campaign no longer exists, so that filter was removed.");
      } else labels.campaign = "A campaign";
    }
  });
  if (out.source) labels.source = CREATED_VIA_LABELS[out.source];
  if (out.channel) labels.channel = CHANNEL_LABELS[out.channel];
  return { filters: out, labels, notices };
}

/**
 * A client report: the chosen sections, each computed only from this workspace's native records for the period and filters. Sections the
 * person can't see are listed with the reason instead of being shown as zeros. Needs the reporting permission.
 */
export async function getCrmReport(actor: CrmActor, input: { filters: ReportFilters; sections?: ReportSection[] | null }, now: Date = new Date()): Promise<CrmReport> {
  assertCan(actor, "crm.view");
  assertCan(actor, "analytics.view", "Reports need the reporting permission. Ask a workspace owner for access.");
  const parsed = reportFiltersSchema.safeParse(input.filters);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the report filters.");
  if (parsed.data.range === "custom") {
    const issue = customRangeIssue(parsed.data.from, parsed.data.to, todayIn(actor.timezone || "UTC", now));
    if (issue) throw new AppError("invalid_input", issue);
  } else {
    delete parsed.data.from;
    delete parsed.data.to;
  }
  const { filters, labels, notices } = await checkFilters(actor, parsed.data);
  const scope = await buildScope(actor, filters, now);
  const requested = REPORT_SECTIONS.filter((s) => !input.sections?.length || input.sections.includes(s));
  const sections: CrmReport["sections"] = [];
  const hidden: CrmReport["hidden"] = [];
  for (const s of requested) {
    const reason = hiddenReason(actor, s);
    if (reason) {
      hidden.push({ section: s, reason });
      continue;
    }
    const result = (await COMPUTE[s](scope)) as SectionResult;
    result.ignored = [...new Set([...ignoredFilters(s, filters), ...result.ignored])];
    sections.push(result as CrmReport["sections"][number]);
  }
  return {
    generatedAt: now.toISOString(),
    timezone: scope.timezone,
    period: { ...scope.dates, startsAt: scope.startsAt.toISOString(), endsAt: scope.endsAt.toISOString(), dated: sections.some((s) => SECTION_INFO[s.section].dated) },
    filters,
    filterLabels: labels,
    sections,
    hidden,
    notices,
  };
}

/** The choices the filter bar offers: active team members, live native pipelines, and campaigns (for people who can see them). */
export async function getReportOptions(actor: CrmActor): Promise<ReportOptions> {
  assertCan(actor, "analytics.view");
  return crmRead(actor, async (db) => {
    const members = await db.query<{ id: string; name: string }>(
      `select m.user_id as id, coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' order by lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      [actor.orgId],
    );
    const pipelines = actor.can("sales.view")
      ? (await db.query<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, position, lower(name)", [actor.orgId])).rows
      : [];
    const campaigns = actor.can("campaigns.manage")
      ? (await db.query<{ id: string; name: string; channel: string }>("select id, name, channel from crm_campaigns where org_id = $1 and status <> 'cancelled' order by created_at desc limit 100", [actor.orgId])).rows
      : [];
    return { members: members.rows, pipelines, campaigns };
  });
}
