import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import { AGENT_BY_KEY, isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import { BUSINESS_GOALS, onboardingSchema, websiteLooksValid, type OnboardingData } from "@/lib/agent-settings";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings, detectRiskFlags, sanitizeClientText } from "@/server/workforce/compiler";
import { queueOnboardingPreparations } from "@/server/setup/jobs";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { ensureSetupInstance } from "@/server/setup/core";
import { reconcileSetupAutomation } from "@/server/setup/automation";
import type { OrgContext } from "@/server/tenancy/context";

export interface OnboardingState {
  data: OnboardingData;
  step: number;
  completedAt: string | null;
  enabledRoles: AgentRoleKey[];
}

export async function getOnboarding(ctx: OrgContext): Promise<OnboardingState> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ data: unknown; current_step: number; completed_at: Date | null }>(
      "select data, current_step, completed_at from onboarding_responses where org_id = $1",
      [ctx.org.orgId],
    );
    const { rows: agents } = await db.query<{ role_key: string }>(
      "select a.role_key from agent_instances a join agent_roles r on r.key = a.role_key where a.org_id = $1 and a.enabled order by r.sort_order",
      [ctx.org.orgId],
    );
    const parsed = onboardingSchema.safeParse(rows[0]?.data ?? {});
    const data = parsed.success ? parsed.data : onboardingSchema.parse({});
    if (!data.business.companyName) data.business.companyName = ctx.org.name;
    // Workspaces set up by iAcquire (or before answers were saved) start from the saved profile
    // rather than blank fields. Only empty answers are filled in.
    const { rows: profile } = await db.query<{ description: string; services: string; ideal_customers: string; operating_area: string; industry: string | null; website: string | null }>(
      `select p.description, p.services, p.ideal_customers, p.operating_area, o.industry, o.website
       from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [ctx.org.orgId],
    );
    const p = profile[0];
    if (p) {
      const fill = (k: keyof OnboardingData["business"], v: string | null | undefined) => {
        if (!data.business[k] && v) data.business[k] = v.slice(0, k === "industry" ? 120 : k === "website" ? 300 : k === "operatingArea" ? 500 : 2000);
      };
      fill("description", p.description);
      fill("services", p.services);
      fill("idealCustomers", p.ideal_customers);
      fill("operatingArea", p.operating_area);
      fill("industry", p.industry);
      fill("website", p.website);
    }
    const enabledRoles = agents.map((a) => a.role_key).filter(isAgentRoleKey);
    if (!data.workforce.selected.length) data.workforce.selected = enabledRoles;
    return {
      data,
      step: rows[0]?.current_step ?? 1,
      completedAt: rows[0]?.completed_at ? new Date(rows[0].completed_at).toISOString() : null,
      enabledRoles,
    };
  });
}

/** Autosave. Saves whatever the client has typed so far; validation happens on completion. */
export async function saveOnboardingProgress(ctx: OrgContext, step: number, data: unknown) {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and admins can complete company setup.");
  const parsed = onboardingSchema.safeParse(data);
  if (!parsed.success) throw new AppError("invalid_input", "Some answers are too long. Please shorten them.");
  const safeStep = Math.min(5, Math.max(1, Math.trunc(step)));
  await withUser(ctx.user.id, (db) =>
    db.query(
      `insert into onboarding_responses (org_id, current_step, data, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id) do update set current_step = excluded.current_step, data = excluded.data, updated_by = excluded.updated_by`,
      [ctx.org.orgId, safeStep, JSON.stringify(parsed.data), ctx.user.id],
    ),
  );
}

export interface GeneratedEmployee {
  role: AgentRoleKey;
  name: string;
  summary: string;
  configStatus: string;
  agentStatus: string;
}

export function validateForCompletion(data: OnboardingData): Record<string, string> {
  const errors: Record<string, string> = {};
  if (data.business.companyName.trim().length < 2) errors.companyName = "Add your company name.";
  if (data.business.description.trim().length < 10) errors.description = "Describe what your business does in a sentence or two.";
  if (!websiteLooksValid(data.business.website.trim())) errors.website = "That website address doesn't look right.";
  if (!data.goals.selected.length) errors.goals = "Choose at least one goal.";
  if (data.goals.selected.some((g) => !BUSINESS_GOALS.some((b) => b.id === g))) errors.goals = "Unknown goal selected.";
  if (!data.workforce.selected.length) errors.workforce = "Choose at least one AI employee to configure.";
  return errors;
}

/**
 * Step 5 — "Generate your AI team". Saves the company profile and knowledge, builds a versioned,
 * policy-wrapped configuration for each selected employee, and opens provisioning requests.
 * Employees stay "Setup required" until a dedicated Hermes profile passes a real health check.
 */
export async function completeOnboarding(ctx: OrgContext): Promise<{ employees: GeneratedEmployee[] }> {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and admins can complete company setup.");
  const state = await getOnboarding(ctx);
  const data = state.data;
  const errors = validateForCompletion(data);
  if (Object.keys(errors).length) throw new AppError("invalid_input", Object.values(errors)[0]);
  const selected = data.workforce.selected.filter(isAgentRoleKey).filter((r) => state.enabledRoles.includes(r));
  if (!selected.length) throw new AppError("invalid_input", "None of the selected employees are enabled for your workspace.");

  const b = data.business;
  const goalLabels = data.goals.selected
    .filter((g) => g !== "other")
    .map((g) => BUSINESS_GOALS.find((x) => x.id === g)?.label ?? g)
    .concat(data.goals.other ? [sanitizeClientText(data.goals.other, 200)] : []);
  const website = b.website.trim() ? (/^https?:\/\//i.test(b.website.trim()) ? b.website.trim() : `https://${b.website.trim()}`) : "";

  const employees = await withSystem(async (db) => {
    await db.query(
      `update organizations set name = $2, industry = nullif($3, ''), website = nullif($4, ''), region = nullif($5, ''),
         status = case when status in ('invited', 'onboarding') then 'active' else status end,
         onboarding_completed_at = coalesce(onboarding_completed_at, now())
       where id = $1`,
      [ctx.org.orgId, sanitizeClientText(b.companyName, 120), sanitizeClientText(b.industry, 120), website, sanitizeClientText(b.operatingArea, 200)],
    );
    await db.query(
      `insert into company_profiles (org_id, description, services, ideal_customers, operating_area, goals, goals_other, ai_preferences, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (org_id) do update set description = excluded.description, services = excluded.services,
         ideal_customers = excluded.ideal_customers, operating_area = excluded.operating_area, goals = excluded.goals,
         goals_other = excluded.goals_other, ai_preferences = company_profiles.ai_preferences || excluded.ai_preferences,
         updated_by = excluded.updated_by`,
      [
        ctx.org.orgId, sanitizeClientText(b.description, 4000), sanitizeClientText(b.services, 4000),
        sanitizeClientText(b.idealCustomers, 4000), sanitizeClientText(b.operatingArea, 1000), goalLabels,
        sanitizeClientText(data.goals.other, 500), JSON.stringify(data.communication), ctx.user.id,
      ],
    );
    // Seed the Knowledge Center from the answers without overwriting anything already written there.
    for (const [section, content] of [
      ["business_description", b.description],
      ["products_services", b.services],
    ] as const) {
      const text = sanitizeClientText(content, 12000);
      if (!text) continue;
      const flags = detectRiskFlags(text);
      await db.query(
        `insert into company_knowledge (org_id, section, content, updated_by, risk_flags, review_status, applied_at)
         values ($1, $2, $3, $4, $5, $6, case when $6 = 'approved' then now() end)
         on conflict (org_id, section) do nothing`,
        [ctx.org.orgId, section, text, ctx.user.id, flags, flags.length ? "pending_agency_review" : "approved"],
      );
    }

    const out: GeneratedEmployee[] = [];
    const { rows: agents } = await db.query<{ id: string; role_key: string; status: string; active_config_version_id: string | null }>(
      "select id, role_key, status, active_config_version_id from agent_instances where org_id = $1",
      [ctx.org.orgId],
    );
    for (const role of selected) {
      const agent = agents.find((a) => a.role_key === role);
      if (!agent) continue;
      const settings = defaultSettings(role, data.communication);
      settings.roleAnswers = Object.fromEntries(
        AGENT_BY_KEY[role].questions
          .map((q) => [q.id, sanitizeClientText(data.workforce.answers[role]?.[q.id] ?? "", 1000)] as const)
          .filter(([, v]) => v),
      );
      if (role === "lead_hunter") settings.targetCustomers = sanitizeClientText(b.idealCustomers, 1000);
      const v = await createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings,
        source: "onboarding",
        userId: ctx.user.id,
        apply: true,
      });
      out.push({ role, name: AGENT_BY_KEY[role].name, summary: v.summary, configStatus: v.status, agentStatus: agent.status });
    }
    await db.query("update onboarding_responses set completed_at = now(), current_step = 5, updated_by = $2 where org_id = $1", [ctx.org.orgId, ctx.user.id]);
    await ensureSetupInstance(db, ctx.org.orgId);
    await requestProvisioning(db, ctx.org.orgId, ctx.user.id);
    await queueOnboardingPreparations(db, ctx.org.orgId, ctx.user.id);
    await notifyAgency(db, ctx.org.orgId, {
      kind: "system",
      severity: "info",
      title: `${sanitizeClientText(b.companyName, 80)} finished company setup`,
      body: `${out.length} AI employee configuration${out.length === 1 ? "" : "s"} prepared.`,
      link: `/admin/clients/${ctx.org.orgId}`,
    });
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "onboarding.completed", targetType: "organization", targetId: ctx.org.orgId, result: "success", metadata: { employees: selected } },
      db,
    );
    return out;
  });
  // Submitting company information is verifiable from recorded data, so it can complete its step.
  try {
    await reconcileSetupAutomation(ctx.org.orgId);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] setup sync after onboarding failed", err);
  }
  return { employees };
}
