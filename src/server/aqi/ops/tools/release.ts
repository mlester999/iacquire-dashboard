import "server-only";
import { z } from "zod";
import { listMigrationFiles, readSystem } from "@/server/db";
import { env } from "@/server/env";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, iso, metric, newCardId, plural } from "@/server/aqi/ops/tools/helpers";
import type { OpsMetricsCard, OpsTimelineCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

/** The only deployment facts the host injects at runtime. None of them is a claim that a deploy is healthy. */
export function runtimeRelease(source: NodeJS.ProcessEnv = process.env) {
  const pick = (k: string) => (source[k] && source[k]!.trim() ? source[k]!.trim() : null);
  return {
    environment: pick("VERCEL_ENV"),
    commit: pick("VERCEL_GIT_COMMIT_SHA"),
    branch: pick("VERCEL_GIT_COMMIT_REF"),
    deploymentId: pick("VERCEL_DEPLOYMENT_ID"),
    region: pick("VERCEL_REGION"),
    nodeEnv: pick("NODE_ENV"),
  };
}

export const releaseInfo = defineReadTool({
  id: "release.info",
  title: "Running release and migrations",
  description: "The commit and environment this server reports, whether every migration in this release is recorded as applied, and the most recent applied migrations. Does not assert that the release is healthy.",
  group: "release",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["platform"],
  input: z.object({}).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 8_000,
  async run() {
    const release = runtimeRelease();
    const files = listMigrationFiles().map((f) => f.replace(/\.sql$/, ""));
    const { rows } = await readSystem((db) => db.query<{ version: string; applied_at: Date }>("select version, applied_at from schema_migrations where version <> 'compat_local_supabase_1' order by applied_at desc limit 200"));
    const applied = new Set(rows.map((r) => r.version));
    const pending = files.filter((f) => !applied.has(f));
    const unknownApplied = rows.filter((r) => !files.includes(r.version)).map((r) => r.version);
    const latestApplied = rows.slice(0, 6);
    const e = env();
    const schedulerConfigured = Boolean(e.SCHEDULER_ENABLED && e.CRON_SECRET);

    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: "Running release", asOf: new Date().toISOString(), source: "Server runtime variables and schema_migrations", refresh: { toolId: "release.info", args: {} },
      metrics: [
        metric("Environment", release.environment ?? "Not reported", release.nodeEnv ?? undefined, release.environment ? undefined : "unknown"),
        metric("Commit", release.commit ? release.commit.slice(0, 10) : "Not reported", release.branch ? `branch ${clean(release.branch, 60)}` : "The host did not expose the commit", release.commit ? undefined : "unknown"),
        metric("Migrations in this release", files.length, files.at(-1) ?? undefined), metric("Not recorded as applied", pending.length, pending.slice(0, 3).join(", ") || undefined, pending.length ? "degraded" : "healthy"),
        metric("Scheduler", schedulerConfigured ? "Configured" : "Not configured", schedulerConfigured ? undefined : "Background jobs run only when triggered externally", schedulerConfigured ? undefined : "not_configured"),
      ],
      caveats: [
        "Deployment status, build logs, CI results and error monitoring are not integrated, so a successful build or a deployed commit does not show that production is healthy. Check System health for runtime evidence.",
        "Whether a commit was pushed, deployed or verified in production cannot be determined from inside the running application.",
      ],
    };
    const timeline: OpsTimelineCard = {
      id: newCardId(), kind: "timeline", title: "Latest applied migrations", asOf: new Date().toISOString(), source: "schema_migrations",
      events: latestApplied.slice().reverse().map((r) => ({ at: iso(r.applied_at)!, label: r.version, tone: "neutral" as const })),
      verdict: pending.length ? `${plural(pending.length, "migration")} in this release ${pending.length === 1 ? "is" : "are"} not recorded as applied.` : "Every migration in this release is recorded as applied.",
    };
    return {
      summary: `This server reports ${release.environment ?? "no environment"}${release.commit ? `, commit ${release.commit.slice(0, 10)}${release.branch ? ` on ${clean(release.branch, 60)}` : ""}` : ", and does not expose a commit id"}. ${files.length} migrations ship with this release; ${pending.length ? `${pending.length} not recorded as applied: ${pending.slice(0, 5).join(", ")}` : "all are recorded as applied"}${unknownApplied.length ? `; ${unknownApplied.length} applied versions have no file in this release (a newer or older release may have run them)` : ""}. This does not show that the release is healthy.`,
      data: { release, migrationFiles: files.length, newestMigrationFile: files.at(-1), pendingMigrations: pending, appliedWithoutFile: unknownApplied.slice(0, 10), latestApplied: latestApplied.map((r) => ({ version: r.version, appliedAt: iso(r.applied_at) })), schedulerConfigured, distinction: "committed, pushed, deployed and production-verified are different states; only the running commit and migration records are visible here." },
      cards: [metrics, timeline],
      evidence: { label: "Running release and migrations", source: "Runtime environment variables and schema_migrations", href: "/admin/health" },
      unavailable: ["Deployment history, CI and test results, release notes and error-monitoring data are not integrated, so what changed in the latest release and whether it introduced errors cannot be determined from here."],
    };
  },
});

export const RELEASE_TOOLS = [releaseInfo];
