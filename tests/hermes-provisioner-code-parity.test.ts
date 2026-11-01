import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProvisioningFailureCode, PROVISIONING_FAILURE_CODES, UNCLASSIFIED_FAILURE_CODE } from "@/lib/provisioning-failure";

// The worker (services/hermes-provisioner/worker.py) and the portal (src/lib/provisioning-failure.ts) must agree on the failure codes a job can end with. A code the portal does
// not know used to make the whole completion fail validation, so the failure was never recorded and the job sat in progress. This reads the real worker source.
const worker = readFileSync(path.join(process.cwd(), "services", "hermes-provisioner", "worker.py"), "utf8");

// Codes the worker raises only while it starts up, before it has claimed anything: it exits and no job is ever failed with them.
const START_UP_ONLY = new Set([
  "client_model_config_invalid", "client_model_config_missing", "hermes_cli_unavailable", "hermes_cli_preflight_failed",
  "portal_url_invalid", "portal_url_must_use_https", "provisioner_credentials_missing", "unsupported_profile_create_cli", "worker_must_not_run_as_root",
]);

const literalCodes = new Set([...worker.matchAll(/ProvisioningError\(\s*"([a-z0-9_]+)"\s*\)/g)].map((match) => match[1]));
// _wait_for_effective_toolsets raises whatever failure_code it was called with.
const passedCodes = new Set([...worker.matchAll(/failure_code="([a-z0-9_]+)"/g)].map((match) => match[1]));
const canarySuffixes = (() => {
  const block = /SAFE_CANARY_ERROR_CODE_SUFFIXES\s*=\s*\{([^}]*)\}/.exec(worker);
  return block ? [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]) : [];
})();

describe("the portal accepts every failure code the worker can raise while a job runs", () => {
  it("found the worker's codes (so the checks below are not vacuous)", () => {
    expect(literalCodes.size).toBeGreaterThan(40);
    expect(literalCodes.has("profile_gateway_discovery_timeout")).toBe(true);
    expect(passedCodes.has("runtime_tool_policy_unverified")).toBe(true);
    expect(passedCodes.has("canary_tool_isolation_failed")).toBe(true);
    expect(canarySuffixes.length).toBeGreaterThanOrEqual(8);
    expect(worker).toContain('f"canary_submission_http_{safe_status}{suffix}"');
    expect(worker).toContain('"canary_failed_" + safe_code');
  });

  it("knows every literal job-time code, unchanged", () => {
    const jobTime = [...literalCodes, ...passedCodes].filter((code) => !START_UP_ONLY.has(code));
    const unknown = jobTime.filter((code) => !(PROVISIONING_FAILURE_CODES as readonly string[]).includes(code));
    expect(unknown).toEqual([]);
    for (const code of jobTime) expect(normalizeProvisioningFailureCode(code)).toBe(code);
  });

  it("knows every canary_failed_<reason> the worker can build", () => {
    for (const suffix of canarySuffixes) expect(normalizeProvisioningFailureCode("canary_failed_" + suffix), suffix).toBe("canary_failed_" + suffix);
  });

  it("keeps every canary_submission_http_<status>[_<gateway code>] the worker can build", () => {
    // The worker's own pattern for the gateway's error code; the samples are what it lets through.
    expect(worker).toContain('RUN_SUBMISSION_ERROR_CODE_RE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+")');
    const statuses = ["100", "200", "400", "401", "404", "409", "422", "429", "500", "502", "503", "504", "599", "unavailable"];
    const gatewayCodes = ["", "_profile_mismatch", "_invalid_request", "_rate_limit_exceeded", "_a1_b2_c3"];
    for (const status of statuses) {
      for (const gatewayCode of gatewayCodes) {
        const code = `canary_submission_http_${status}${gatewayCode}`;
        expect(normalizeProvisioningFailureCode(code), code).toBe(code);
      }
    }
  });

  it("does not hide a worker code behind the start-up list", () => {
    // If the portal knew a start-up code anyway, listing it here would be dead weight; if the worker stopped raising one, the list should shrink.
    for (const code of START_UP_ONLY) {
      expect(literalCodes.has(code), code).toBe(true);
      expect(normalizeProvisioningFailureCode(code), code).toBe(UNCLASSIFIED_FAILURE_CODE);
    }
  });
});
