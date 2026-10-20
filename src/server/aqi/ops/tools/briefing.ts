import "server-only";
import { z } from "zod";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { composeBriefing } from "@/server/aqi/ops/briefing";
import { newCardId } from "@/server/aqi/ops/tools/helpers";
import type { OpsBriefingCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

export const briefingCompose = defineReadTool({
  id: "briefing.compose",
  title: "Operations briefing",
  description: "A briefing over a stated reporting period covering platform health, incidents, failed Hermes runs, pending approvals, blocked onboarding, support tickets, integration failures and cost anomalies, with recommended next steps and its data sources.",
  group: "briefing",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["platform"],
  input: z.object({ hours: z.number().int().min(6).max(336).default(24) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 30_000,
  async run(ctx, args) {
    const briefing = await composeBriefing({ userId: ctx.user.id, now: ctx.now, hours: args.hours, kind: "on_demand" });
    const card: OpsBriefingCard = {
      id: newCardId(), kind: "briefing", title: briefing.title, asOf: briefing.generatedAt, source: briefing.sources.length ? `${briefing.sources.length} data sources` : "Recorded system state",
      refresh: { toolId: "briefing.compose", args }, period: briefing.period, summary: briefing.summary, noteworthy: briefing.noteworthy, sections: briefing.sections, recommended: briefing.recommended, sources: briefing.sources,
    };
    return {
      summary: `${briefing.title}. Reporting period ${briefing.period.from.slice(0, 16)} to ${briefing.period.to.slice(0, 16)} UTC (${briefing.period.hours} h). ${briefing.summary} ${briefing.sections.map((s) => `${s.title}: ${s.items.map((i) => i.text).join(" ")}`).join(" ")} Recommended: ${briefing.recommended.map((r) => r.text).join(" ") || "nothing specific."}`,
      data: { period: briefing.period, summary: briefing.summary, sections: briefing.sections.map((s) => ({ section: s.title, state: s.state, items: s.items.map((i) => i.text) })), recommended: briefing.recommended.map((r) => r.text), sources: briefing.sources },
      cards: [card],
      evidence: { label: "Operations briefing", source: briefing.sources.join("; ").slice(0, 400), href: "/admin/operations" },
    };
  },
});

export const BRIEFING_TOOLS = [briefingCompose];
