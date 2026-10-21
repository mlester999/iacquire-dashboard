import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, iso, newCardId, plural } from "@/server/aqi/ops/tools/helpers";
import type { OpsChartCard, OpsTableCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

interface ThemeRow {
  request_type: string; category: string; feature: string; n: number; clients: number; open_n: number; blocking: number; latest: Date; samples: string[] | null;
}

export const productRequests = defineReadTool({
  id: "product.requests",
  title: "What clients ask for and report most",
  description: "Recurring issue reports and feedback or feature requests grouped by category and affected feature, ranked by distinct clients, volume and blocking urgency, with sample titles.",
  group: "product",
  roles: SUPER,
  permission: "agency.support.analytics",
  scopes: ["platform", "tenant"],
  input: z.object({ days: z.number().int().min(7).max(365).default(90), limit: z.number().int().min(1).max(12).default(8) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 12_000,
  async run(ctx, args) {
    const orgId = ctx.scope.orgId;
    if (orgId) await ctx.authorizeOrg(orgId, "product.requests");
    const since = new Date(ctx.now.getTime() - args.days * 86_400_000).toISOString();
    const { rows } = await readSystem((db) => db.query<ThemeRow>(
      `select g.request_type, g.category, g.feature, g.n, g.clients, g.open_n, g.blocking, g.latest,
              (select array_agg(left(s.subject, 80)) from (select x.subject from support_tickets x
                  where x.request_type = g.request_type and x.category = g.category and coalesce(x.affected_feature, '') = g.feature and x.created_at >= $1
                    and app.user_can_access_org($2, x.org_id) and ($3::uuid is null or x.org_id = $3) order by x.created_at desc limit 3) s) as samples
         from (select t.request_type, t.category, coalesce(t.affected_feature, '') as feature, count(*)::int as n, count(distinct t.org_id)::int as clients,
                      count(*) filter (where t.status in ('new', 'open', 'in_progress', 'waiting_for_client'))::int as open_n,
                      count(*) filter (where t.client_urgency = 'blocking')::int as blocking, max(t.created_at) as latest
                 from support_tickets t
                where t.request_type in ('issue', 'feedback') and t.created_at >= $1 and app.user_can_access_org($2, t.org_id) and ($3::uuid is null or t.org_id = $3)
                group by 1, 2, 3) g
        order by g.clients desc, g.blocking desc, g.n desc, g.latest desc limit $4`,
      [since, ctx.user.id, orgId, args.limit],
    ));
    const label = (r: ThemeRow) => `${r.category.replace(/_/g, " ")}${r.feature ? ` · ${r.feature.replace(/_/g, " ")}` : ""}`;
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: `Recurring themes, last ${args.days} days`, asOf: new Date().toISOString(), source: "Support & Requests (issue reports and feedback)", refresh: { toolId: "product.requests", args },
      caption: "Ranked by distinct clients, then blocking reports, then volume. Complexity and revenue impact are not recorded, so they are not part of the ranking.",
      columns: [{ key: "theme", label: "Theme" }, { key: "type", label: "Type" }, { key: "clients", label: "Clients", align: "right" }, { key: "requests", label: "Requests", align: "right" }, { key: "blocking", label: "Blocking", align: "right" }, { key: "open", label: "Open", align: "right" }],
      rows: rows.map((r) => ({ theme: clean(label(r), 70), type: r.request_type === "issue" ? "Issue" : "Feedback", clients: r.clients, requests: r.n, blocking: r.blocking, open: r.open_n, _href: "/admin/support" })),
    };
    const chart: OpsChartCard = {
      id: newCardId(), kind: "chart", title: "Clients affected by theme", asOf: new Date().toISOString(), source: "Support & Requests", unit: "clients",
      series: rows.slice(0, 6).map((r) => ({ label: clean(label(r), 40), value: r.clients, detail: `${r.n} request${r.n === 1 ? "" : "s"}` })),
    };
    return {
      summary: rows.length ? `${plural(rows.length, "theme")} in the last ${args.days} days. Most widespread: ${rows.slice(0, 3).map((r) => `${label(r)} (${plural(r.clients, "client")}, ${plural(r.n, "request")}${r.blocking ? `, ${r.blocking} reported as blocking` : ""})`).join("; ")}. Ranking uses recorded counts only; it is not a demand forecast.` : `No issue reports or feedback were recorded in the last ${args.days} days.`,
      data: { windowDays: args.days, themes: rows.map((r) => ({ type: r.request_type, category: r.category, feature: r.feature || null, requests: r.n, distinctClients: r.clients, open: r.open_n, blocking: r.blocking, latest: iso(r.latest), sampleTitles: r.samples ?? [] })), ranking: "distinct clients, then blocking reports, then volume" },
      cards: rows.length ? [table, chart] : [table],
      evidence: { label: "Recurring client requests", source: "Support & Requests (support_tickets)", href: "/admin/support/analytics" },
      unavailable: ["Implementation complexity, revenue impact and client size are not recorded, so recommendations rank on request frequency and severity only. Any engineering work must be proposed as an internal issue and reviewed by a person."],
    };
  },
});

export const PRODUCT_TOOLS = [productRequests];
