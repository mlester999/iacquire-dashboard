import { describe, expect, it } from "vitest";
import {
  safeAcceptanceSeedErrorCode,
  safeAcceptanceSeedStage,
  safeProvisioningFailureCode,
  safeProvisioningFailureCodeList,
  safeProvisioningJobDiagnostics,
  safeStartupFailureCode,
} from "../scripts/hermes-provisioner-acceptance-diagnostics";

describe("Hermes acceptance startup diagnostics", () => {
  it("reports known runtime codes without including their messages", () => {
    const failure = Object.assign(new Error("secret=/run/secrets/token-value"), { code: "ERR_MODULE_NOT_FOUND" });

    expect(safeStartupFailureCode(failure)).toBe("NODE_ERR_MODULE_NOT_FOUND");
  });

  it("classifies missing modules without exposing package paths", () => {
    expect(safeStartupFailureCode(new Error("Cannot find package '/repository/node_modules/tsx'")))
      .toBe("NODE_MODULE_NOT_FOUND");
  });

  it("classifies startup error families and drops arbitrary secret text", () => {
    expect(safeStartupFailureCode(new TypeError("Cannot read properties of undefined (reading 'apiKey')")))
      .toBe("APPLICATION_TYPE_ERROR");
    expect(safeStartupFailureCode(new Error("Bearer sk-live-this-is-not-for-logs"))).toBe("ERROR");
    expect(safeStartupFailureCode({ code: "api_key_secret_value", message: "untrusted" }))
      .toBe("UNCLASSIFIED_STARTUP_ERROR");
  });

  it("keeps only allowlisted seed stages and application failure codes", () => {
    expect(safeAcceptanceSeedStage("tenant_two_onboarding")).toBe("tenant_two_onboarding");
    expect(safeAcceptanceSeedStage("secret-token-value")).toBe("unknown_seed_stage");
    expect(safeAcceptanceSeedErrorCode(new Error("acceptance_onboarding_answers_rejected")))
      .toBe("acceptance_onboarding_answers_rejected");
    expect(safeAcceptanceSeedErrorCode(Object.assign(new Error("token=private"), { code: "42P01" })))
      .toBe("DATABASE_TABLE_MISSING");
    expect(safeAcceptanceSeedErrorCode(new Error("sk-live-do-not-log-this")))
      .toBe("unclassified_seed_error");
  });

  it("exposes only allowlisted restricted-worker failure codes", () => {
    const detail = "Restricted Hermes profile setup failed (runtime_tool_policy_unverified). Review the isolated host result before retrying.";
    expect(safeProvisioningFailureCode(detail)).toBe("runtime_tool_policy_unverified");
    expect(safeProvisioningFailureCode("Restricted Hermes profile setup failed (sk-live-secret). Review the isolated host result before retrying."))
      .toBe("unclassified_provisioner_failure");
    expect(safeProvisioningFailureCode("Bearer sk-live-secret")).toBe("unclassified_provisioner_failure");
    expect(safeProvisioningFailureCodeList([detail, detail, "Bearer sk-live-secret"]))
      .toEqual(["runtime_tool_policy_unverified", "unclassified_provisioner_failure"]);
  });

  it("reports correlated stage and bounded retry state without leaking raw job fields", () => {
    const diagnostics = safeProvisioningJobDiagnostics([
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "provision",
        status: "failed",
        detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying.",
        attempt_count: 1,
        next_retry_at: "2026-10-23T12:40:00.000Z",
        profile: "c-secret-tenant-name",
        org_id: "00000000-0000-4000-8000-000000000099",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        status: "in_progress",
        detail: "Bearer sk-live-never-log-this",
        attempt_count: 2,
        next_retry_at: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        status: "failed",
        detail: "Restricted Hermes profile setup failed (canary_failed_model_endpoint_unreachable). Review the isolated host result before retrying.",
        attempt_count: 3,
        next_retry_at: null,
      },
      {
        id: "not-a-job-id",
        status: "failed",
        detail: "Bearer sk-live-never-log-this",
        attempt_count: 1,
      },
    ]);

    expect(diagnostics).toEqual([
      {
        correlationId: "00000000-0000-4000-8000-000000000001",
        jobStatus: "failed",
        stage: "canary_verification",
        errorCategory: "unclassified_hermes_run_failure",
        safeExceptionDetail: "Terminal Hermes run had no allowlisted error code.",
        attempt: 1,
        maxAttempts: 3,
        retryState: "retry_scheduled",
      },
      {
        correlationId: "00000000-0000-4000-8000-000000000002",
        jobStatus: "in_progress",
        stage: "in_progress",
        errorCategory: "none_recorded",
        safeExceptionDetail: "No failure recorded yet.",
        attempt: 2,
        maxAttempts: 3,
        retryState: "in_progress",
      },
      {
        correlationId: "00000000-0000-4000-8000-000000000003",
        jobStatus: "failed",
        stage: "canary_verification",
        errorCategory: "hermes_run_failure",
        safeExceptionDetail: "Hermes canary run reported model_endpoint_unreachable.",
        attempt: 3,
        maxAttempts: 3,
        retryState: "retry_exhausted",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret-tenant|sk-live|Bearer|org_id|profile/);
  });
});
