import { describe, expect, it } from "vitest";
import {
  safeAcceptanceSeedErrorCode,
  safeAcceptanceSeedStage,
  safeProvisioningFailureCode,
  safeProvisioningFailureCodeList,
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
});
