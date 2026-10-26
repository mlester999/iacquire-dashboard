import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listMigrationFiles, MIGRATION_PREREQUISITES } from "@/server/db";

// The migration runner treats a file as already applied when its numeric prefix appears in the Supabase CLI ledger (supabase_migrations.schema_migrations,
// which hosted projects have), and records each file there by prefix with "on conflict do nothing". Two files that share a prefix would therefore let the
// second one be skipped without a message after the first has been applied. This test turns that into a failure before it can reach a database.

const prefix = (file: string) => file.slice(0, file.indexOf("_"));
const duplicates = (files: string[]) => {
  const seen = new Map<string, string[]>();
  for (const f of files) seen.set(prefix(f), [...(seen.get(prefix(f)) ?? []), f]);
  return [...seen.entries()].filter(([, names]) => names.length > 1).map(([p, names]) => `${p}: ${names.join(", ")}`);
};

describe("migration file numbers", () => {
  it("gives every migration its own number", () => {
    expect(duplicates(listMigrationFiles())).toEqual([]);
  });

  it("gives every rollback its own number", () => {
    expect(duplicates(readdirSync("supabase/rollbacks").filter((f) => /^\d{4}_.+\.sql$/.test(f)))).toEqual([]);
  });

  it("only names migrations that exist as prerequisites, each earlier than the one that needs it", () => {
    const names = new Set(listMigrationFiles().map((f) => f.replace(/\.sql$/, "")));
    for (const [version, required] of Object.entries(MIGRATION_PREREQUISITES)) {
      expect(names.has(version), `${version} is in the prerequisite list but has no file`).toBe(true);
      for (const r of required) {
        expect(names.has(r), `${version} requires ${r}, which has no file`).toBe(true);
        expect(r < version, `${version} requires ${r}, which does not come before it`).toBe(true);
      }
    }
  });

  it("keeps the inbox migration behind the last migration that rewrites the notification kinds from a copied list", () => {
    expect(MIGRATION_PREREQUISITES["0083_unified_inbox"]).toContain("0065_support_requests");
  });

  it("keeps restricted Hermes provisioning behind the client provisioning queue", () => {
    expect(MIGRATION_PREREQUISITES["0084_restricted_hermes_provisioner"]).toContain("0082_client_employee_provisioning");
  });

  it("keeps appointment chat booking previews behind the chat schedule migration", () => {
    expect(MIGRATION_PREREQUISITES["0107_workforce_chat_booking_previews"]).toContain("0106_workforce_chat_schedule_previews");
  });

  it("keeps the workforce schedule proposal chain behind its schema prerequisites", () => {
    expect(MIGRATION_PREREQUISITES["0105_workforce_local_recurrence"]).toContain("0078_ai_work_schedules");
    expect(MIGRATION_PREREQUISITES["0106_workforce_chat_schedule_previews"]).toContain("0105_workforce_local_recurrence");
    expect(MIGRATION_PREREQUISITES["0108_workforce_appointment_changes"]).toContain("0107_workforce_chat_booking_previews");
    expect(MIGRATION_PREREQUISITES["0109_employee_health_probe"]).toEqual(["0059_hermes_tool_inventory", "0060_rls_initplan"]);
  });

  it("notices a shared number (the check itself works)", () => {
    expect(duplicates(["0082_client_employee_provisioning.sql", "0082_unified_inbox.sql", "0083_other.sql"])).toEqual(["0082: 0082_client_employee_provisioning.sql, 0082_unified_inbox.sql"]);
  });
});
