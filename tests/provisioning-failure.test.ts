import { describe, expect, it } from "vitest";
import {
  classifyProvisioningFailure,
  normalizeProvisioningFailureCode,
  PROVISIONING_FAILURE_CODES,
  provisioningRetryPlan,
  RETRY_GIVE_BACK_MAX_AGE_SECONDS,
  UNCLASSIFIED_FAILURE_CODE,
} from "@/lib/provisioning-failure";

describe("provisioning failure codes", () => {
  it("keeps every known code unchanged, including the two the worker can raise mid-job", () => {
    for (const code of PROVISIONING_FAILURE_CODES) expect(normalizeProvisioningFailureCode(code)).toBe(code);
    expect(PROVISIONING_FAILURE_CODES).toContain("profile_gateway_discovery_timeout");
    expect(PROVISIONING_FAILURE_CODES).toContain("capacity_exceeded");
  });

  it("keeps a well-formed canary_submission_http code and nothing that only looks like one", () => {
    for (const code of ["canary_submission_http_409_profile_mismatch", "canary_submission_http_503", "canary_submission_http_unavailable", "canary_submission_http_422_invalid_request_body"]) {
      expect(normalizeProvisioningFailureCode(code)).toBe(code);
    }
    for (const code of ["canary_submission_http_", "canary_submission_http_99_x", "canary_submission_http_409_Profile", "canary_submission_http_409_profile mismatch", "canary_submission_http_600"]) {
      expect(normalizeProvisioningFailureCode(code)).toBe(UNCLASSIFIED_FAILURE_CODE);
    }
  });

  it("stores anything else as one fixed code, without echoing it", () => {
    for (const raw of ["", "sk_live_do_not_store_this_value", "Mixed Case!", "x".repeat(101), "canary_failed_something_new", "http_unavailable ", "../../etc/passwd"]) {
      expect(normalizeProvisioningFailureCode(raw)).toBe(UNCLASSIFIED_FAILURE_CODE);
    }
    expect(UNCLASSIFIED_FAILURE_CODE).not.toContain("sk_live");
  });
});

describe("classifying a failure", () => {
  it("treats provider, gateway and network outages as transient", () => {
    for (const code of [
      "http_unavailable", "profile_gateway_discovery_timeout", "canary_events_unavailable", "canary_failed_model_endpoint_unreachable",
      "canary_failed_model_provider_error", "canary_failed_model_unavailable", "capacity_exceeded",
      "canary_submission_http_409_profile_mismatch", "canary_submission_http_503", "canary_submission_http_429_rate_limited", "canary_submission_http_unavailable",
    ]) {
      expect(classifyProvisioningFailure(code), code).toBe("transient");
    }
  });

  it("treats a configuration that changed mid-job as stale", () => {
    expect(classifyProvisioningFailure("stale_configuration")).toBe("stale");
  });

  it("treats real defects, rejected credentials and unknown codes as permanent", () => {
    for (const code of [
      "soul_digest_mismatch", "profile_ownership_conflict", "agency_profile_found", "profile_key_reused", "canary_tool_invoked", "canary_failed_model_authentication_failed",
      "canary_failed_model_credentials_missing", "runtime_tool_inventory_incomplete", "lease_expired", "canary_submission_http_401", "canary_submission_http_409_other_conflict",
      UNCLASSIFIED_FAILURE_CODE, "totally_made_up",
    ]) {
      expect(classifyProvisioningFailure(code), code).toBe("permanent");
    }
  });
});

describe("what a failure does to the attempt budget", () => {
  it("gives a transient attempt back and waits five minutes", () => {
    for (const attemptCount of [1, 2, 3]) {
      expect(provisioningRetryPlan({ code: "canary_failed_model_unavailable", attemptCount, jobAgeSeconds: 60 })).toEqual({
        failureClass: "transient", giveBackAttempt: true, retryAfterSeconds: 300, ageBoundReached: false,
      });
    }
  });

  it("gives a stale attempt back and retries in thirty seconds", () => {
    expect(provisioningRetryPlan({ code: "stale_configuration", attemptCount: 2, jobAgeSeconds: 10 })).toEqual({
      failureClass: "stale", giveBackAttempt: true, retryAfterSeconds: 30, ageBoundReached: false,
    });
  });

  it("keeps the three-attempt budget for a permanent failure: 30, 60 and 120 seconds apart, then done", () => {
    const retries = [1, 2, 3].map((attemptCount) => provisioningRetryPlan({ code: "soul_digest_mismatch", attemptCount, jobAgeSeconds: 10 }));
    expect(retries.map((plan) => plan.retryAfterSeconds)).toEqual([30, 60, null]);
    expect(retries.every((plan) => plan.failureClass === "permanent" && !plan.giveBackAttempt && !plan.ageBoundReached)).toBe(true);
  });

  it("stops giving attempts back once the job is more than a day old", () => {
    const exactly = provisioningRetryPlan({ code: "http_unavailable", attemptCount: 1, jobAgeSeconds: RETRY_GIVE_BACK_MAX_AGE_SECONDS });
    expect(exactly.giveBackAttempt).toBe(true);
    const past = provisioningRetryPlan({ code: "http_unavailable", attemptCount: 3, jobAgeSeconds: RETRY_GIVE_BACK_MAX_AGE_SECONDS + 1 });
    expect(past).toEqual({ failureClass: "transient", giveBackAttempt: false, retryAfterSeconds: null, ageBoundReached: true });
    const stalePast = provisioningRetryPlan({ code: "stale_configuration", attemptCount: 2, jobAgeSeconds: RETRY_GIVE_BACK_MAX_AGE_SECONDS + 5 });
    expect(stalePast.giveBackAttempt).toBe(false);
    expect(stalePast.retryAfterSeconds).toBe(60);
  });

  it("never gives an attempt back when the age cannot be read", () => {
    expect(provisioningRetryPlan({ code: "http_unavailable", attemptCount: 1, jobAgeSeconds: Number.NaN }).giveBackAttempt).toBe(false);
  });
});
