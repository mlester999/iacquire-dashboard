import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Founder decision pending: may the approved whole-workspace offboarding purge delete six-role history? This guard documents the existing purge path without deciding or changing that policy.
const root = process.cwd();
const TARGETS = new Set([
  "agent_instances", "agent_runs", "agent_config_versions", "tool_executions", "chat_conversations", "chat_messages",
  "ai_work_jobs", "ai_work_schedules", "ai_work_triggers", "agent_health_probes",
]);
const ALLOWLIST: Record<string, string> = {
  "src/server/offboarding/service.ts": "executeDeletion performs the gated, audited whole-workspace purge after the retention and export checks.",
  "src/server/workforce/schedules.ts": "deleteSchedule requires agents.configure and scopes the delete by schedule id and the caller's organization.",
  "src/server/workforce/triggers.ts": "deleteTrigger requires agents.configure and scopes the delete by trigger id and the caller's organization.",
  "src/server/workforce/health-probe.ts": "pruneProbeLog deletes only expired telemetry and bounds each cleanup pass by a row limit.",
  "scripts/rehearse-combined-migrations.mjs": "The migration rehearsal deletes fixture rows from its disposable embedded database during cleanup.",
};

function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(root, relativeDir);
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/.test(entry.name) ? [relative] : [];
  });
}

function stripComments(source: string): string {
  let out = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (char === "\n") {
        out += char;
        state = "code";
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        i += 1;
        state = "code";
      } else if (char === "\n") out += char;
      continue;
    }
    if (state !== "code") {
      out += char;
      if (char === "\\") {
        if (next !== undefined) out += source[++i];
      } else if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      i += 1;
      state = "line";
    } else if (char === "/" && next === "*") {
      i += 1;
      state = "block";
    } else {
      out += char;
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
    }
  }
  return out;
}

function tableDeletes(relative: string, source: string): string[] {
  const matches: string[] = [];
  const sql = stripComments(source);
  const dml = /\b(?:delete\s+from|truncate(?:\s+table)?)\s+["'`]?([a-z_][a-z0-9_]*)["'`]?/gi;
  for (const match of sql.matchAll(dml)) {
    const table = match[1].toLowerCase();
    if (TARGETS.has(table)) matches.push(`${relative}:${sql.slice(0, match.index).split("\n").length}:${table}`);
  }
  if (relative === "src/server/offboarding/service.ts") {
    const dynamicPurge = /\bdelete\s+from\s+["'`]\$\{t\}["'`]\s+where\s+org_id\s*=/gi;
    for (const match of sql.matchAll(dynamicPurge)) matches.push(`${relative}:${sql.slice(0, match.index).split("\n").length}:tenantTables() purge`);
  }
  return matches;
}

describe("legacy-record deletion guard", () => {
  it("keeps deletes of six-role and work-history tables visible and justified", () => {
    const files = [...walk("src"), ...walk("scripts")];
    const findings = files.flatMap((relative) => tableDeletes(relative, fs.readFileSync(path.join(root, relative), "utf8")));
    const unlisted = findings.filter((finding) => !ALLOWLIST[finding.split(":")[0]]);
    const stale = Object.keys(ALLOWLIST).filter((relative) => !files.some((file) => file === relative && tableDeletes(relative, fs.readFileSync(path.join(root, relative), "utf8")).length > 0));
    expect({ unlisted, stale }, "new or moved legacy-record deletes need review and a one-line reason").toEqual({ unlisted: [], stale: [] });
  });

  it("keeps the five executeDeletion gates ahead of the whole-workspace purge", () => {
    const source = fs.readFileSync(path.join(root, "src/server/offboarding/service.ts"), "utf8");
    const start = source.indexOf("export async function executeDeletion(");
    const end = source.indexOf("/** Reminds the owner", start);
    const executeDeletion = source.slice(start, end);
    expect(executeDeletion).toMatch(/!env\(\)\.OFFBOARDING_PURGE_ENABLED/);
    expect(executeDeletion).toMatch(/r\.status\s*!==\s*"retention"/);
    expect(executeDeletion).toMatch(/!r\.delete_after\s*\|\|\s*new Date\(r\.delete_after\)\.getTime\(\)\s*>\s*Date\.now\(\)/);
    expect(executeDeletion).toMatch(/!r\.billing_closed_at/);
    expect(executeDeletion).toMatch(/!r\.export_downloaded_at[\s\S]*input\.waiveExportReason/);
    expect(executeDeletion).toMatch(/input\.confirmName\.trim\(\)\s*!==\s*r\.org_name\.trim\(\)/);
  });
});
