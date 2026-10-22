import { describe, expect, it } from "vitest";
import { describeDatabaseTarget, migrationScope, parseMigrateArgs } from "@/server/db/migrate-args";

const FILES = ["0079_ai_work_triggers.sql", "0080_proactive_ai_employees.sql", "0081_ai_work_job_rls_hardening.sql", "0082_client_employee_provisioning.sql", "0083_unified_inbox.sql", "0084_restricted_hermes_provisioner.sql"];

describe("the migration runner's options", () => {
  it("reads --only, --through and --dry-run, and keeps today's behaviour when none is given", () => {
    expect(parseMigrateArgs([])).toEqual({ dryRun: false });
    expect(parseMigrateArgs(["--only", "0083_unified_inbox"])).toEqual({ dryRun: false, only: ["0083_unified_inbox"] });
    expect(parseMigrateArgs(["--only", "0084_restricted_hermes_provisioner"])).toEqual({ dryRun: false, only: ["0084_restricted_hermes_provisioner"] });
    expect(parseMigrateArgs(["--only", "0081_a", "0082_b"]).only).toEqual(["0081_a", "0082_b"]);
    expect(parseMigrateArgs(["--through", "0080_proactive_ai_employees"])).toEqual({ dryRun: false, through: "0080_proactive_ai_employees" });
    expect(parseMigrateArgs(["--dry-run", "--only", "0083_unified_inbox"])).toEqual({ dryRun: true, only: ["0083_unified_inbox"] });
    expect(parseMigrateArgs(["--through", "0080_proactive_ai_employees", "--dry-run"]).dryRun).toBe(true);
  });

  it("refuses anything it does not understand, so a typo never applies more than was meant", () => {
    for (const bad of [["--only"], ["--through"], ["--through", "--dry-run"], ["0083_unified_inbox"], ["--all"], ["--only", "--dry-run"]]) expect(() => parseMigrateArgs(bad), bad.join(" ")).toThrow(/Usage/);
    expect(() => parseMigrateArgs(["--only", "0083_x", "--through", "0080_y"])).toThrow(/not both/);
    expect(() => parseMigrateArgs(["--through", "0080_y", "--through", "0081_z"])).toThrow(/more than once/);
  });

  it("turns --through into every migration up to and including it, in order, and refuses an unknown one", () => {
    expect(migrationScope(parseMigrateArgs(["--through", "0080_proactive_ai_employees"]), FILES)).toEqual(["0079_ai_work_triggers", "0080_proactive_ai_employees"]);
    expect(migrationScope(parseMigrateArgs(["--through", "0083_unified_inbox"]), FILES)).toHaveLength(5);
    expect(migrationScope(parseMigrateArgs(["--through", "0084_restricted_hermes_provisioner"]), FILES)).toHaveLength(6);
    expect(migrationScope(parseMigrateArgs(["--only", "0083_unified_inbox"]), FILES)).toEqual(["0083_unified_inbox"]);
    expect(migrationScope(parseMigrateArgs([]), FILES)).toBeUndefined();
    expect(() => migrationScope(parseMigrateArgs(["--through", "0080"]), FILES)).toThrow(/Unknown migration version/);
  });

  it("says which database it would use without ever printing a user name or a password", () => {
    const hosted = "postgresql://postgres.abcdefghijklmnop:S3cret-Pass@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
    const said = describeDatabaseTarget("postgres", hosted);
    expect(said).toBe("aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres");
    expect(said).not.toMatch(/S3cret|postgres\.abcdef/);
    expect(describeDatabaseTarget("pglite-memory", undefined)).toContain("embedded");
    expect(describeDatabaseTarget(undefined, undefined)).toContain("no DATABASE_URL");
    expect(describeDatabaseTarget("postgres", "not a url")).toBe("a DATABASE_URL that could not be read");
  });
});
