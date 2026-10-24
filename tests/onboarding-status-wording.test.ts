import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_STATUS_LABEL, SETUP_REASON_TEXT, SETUP_REQUIRED_LABEL, setupRequiredLine, setupRequiredReason, type AgentStatus } from "@/lib/agents";
import { specialistCaption } from "@/lib/chat-navigation";
import { OPS_EMPLOYEE_STATE_LABEL } from "@/lib/aqi/ops/types";
import { employeeCardStatus } from "@/lib/onboarding/employee-status";
import { deriveEmployeeReadiness, type EmployeeReadinessInput } from "@/lib/workforce-readiness";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import { HELP_ARTICLES } from "@/server/help/articles";

// The status "Setup required" is worded in one place (src/lib/agents.ts) so a founder who prefers "Pending setup" changes one line. And while the status stands, the employee
// card says why: the setup payment is not confirmed, or no Hermes profile is connected yet. Neither wording may leak into an employee that is working.

const STATUSES: AgentStatus[] = ["setup_required", "provisioning", "online", "busy", "offline", "error", "disabled"];

describe("the status wording is one constant", () => {
  it("is the wording the product has always used until the founder changes it", () => {
    expect(SETUP_REQUIRED_LABEL).toBe("Setup required");
  });

  it("is what every label, caption and article reads", () => {
    expect(AGENT_STATUS_LABEL.setup_required).toBe(SETUP_REQUIRED_LABEL);
    expect(specialistCaption("setup_required")).toBe(SETUP_REQUIRED_LABEL);
    expect(OPS_EMPLOYEE_STATE_LABEL.setup_required).toBe(SETUP_REQUIRED_LABEL);
    const unconfigured: EmployeeReadinessInput = { enabled: true, status: "setup_required", configVersion: null, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null };
    expect(deriveEmployeeReadiness(unconfigured).label).toBe(SETUP_REQUIRED_LABEL);
    expect(deriveEmployeeReadiness({ ...unconfigured, paymentCleared: false }).label).toBe(SETUP_REQUIRED_LABEL);
    expect(HELP_ARTICLES.find((a) => a.id === "agent-status")?.title).toContain(SETUP_REQUIRED_LABEL);
  });

  it("is written nowhere else in the source (comments aside), so one line really changes it everywhere", () => {
    const root = path.resolve(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/Setup required/.test(code) && path.relative(root, file).replace(/\\/g, "/") !== "lib/agents.ts") offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe("the reason behind Setup required", () => {
  it("names the payment when it is not confirmed, and the profile otherwise", () => {
    expect(setupRequiredReason({ status: "setup_required", enabled: true, paymentCleared: false })).toBe("setup_payment");
    expect(setupRequiredReason({ status: "setup_required", enabled: true, paymentCleared: true })).toBe("profile_not_connected");
    expect(setupRequiredReason({ status: "setup_required", enabled: true })).toBe("profile_not_connected");
    expect(setupRequiredReason({ status: "setup_required", enabled: true, paymentCleared: null })).toBe("profile_not_connected");
  });

  it("reads exactly as the two sentences the audit asks for", () => {
    expect(setupRequiredLine({ status: "setup_required", enabled: true, paymentCleared: false })).toBe("Setup required: waiting for setup payment");
    expect(setupRequiredLine({ status: "setup_required", enabled: true, paymentCleared: true })).toBe("Setup required: Hermes profile not connected");
    expect(SETUP_REASON_TEXT.setup_payment).toBe("waiting for setup payment");
    expect(SETUP_REASON_TEXT.profile_not_connected).toBe("Hermes profile not connected");
  });

  it("says nothing for any other status or for an employee that is switched off, whatever the payment", () => {
    for (const status of STATUSES) {
      for (const enabled of [true, false]) {
        for (const paymentCleared of [true, false, undefined, null]) {
          const reason = setupRequiredReason({ status, enabled, paymentCleared });
          expect(reason !== null).toBe(status === "setup_required" && enabled);
          if (reason === "setup_payment") expect(paymentCleared).toBe(false);
          expect(setupRequiredLine({ status, enabled, paymentCleared }) !== null).toBe(reason !== null);
        }
      }
    }
  });
});

describe("what an employee card says", () => {
  const at = "2026-10-20T00:00:00.000Z";
  const base: EmployeeReadinessInput = { displayName: "Sales Assistant", enabled: true, status: "setup_required", configVersion: 1, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null, evaluatedAt: at };
  const working: EmployeeReadinessInput = {
    ...base, configVersion: 2, status: "online", lastHealthCheckAt: at, lastHealthOk: true, credentialCurrent: true,
    inventoryContract: "hermes.api_server.tool_catalog.v1", inventoryDigest: "a".repeat(64), inventoryVerifiedAt: at, inventoryExpiresAt: "2026-10-20T00:02:00.000Z", inventoryToolCount: 6,
  };
  const card = (input: EmployeeReadinessInput) => employeeCardStatus(deriveEmployeeReadiness(input), { status: input.status, enabled: input.enabled, paymentCleared: input.paymentCleared });

  it("waiting for the payment: the pill is Setup required and the line says the payment", () => {
    expect(card({ ...base, paymentCleared: false })).toEqual({ label: "Setup required", line: "Setup required: waiting for setup payment" });
    expect(card({ ...base, configVersion: null, paymentCleared: false }).line).toBe("Setup required: waiting for setup payment");
  });

  it("paid, with no connected profile: the pill is Setup required and the line says the Hermes profile", () => {
    for (const paymentCleared of [true, undefined]) {
      expect(card({ ...base, paymentCleared })).toEqual({ label: "Setup required", line: "Setup required: Hermes profile not connected" });
      expect(card({ ...base, configVersion: null, paymentCleared }).line).toBe("Setup required: Hermes profile not connected");
    }
  });

  it("never overrides an employee that is working, even after a refund", () => {
    for (const paymentCleared of [true, false, undefined]) {
      const readiness = deriveEmployeeReadiness({ ...working, paymentCleared });
      expect(readiness.chatAvailable).toBe(true);
      expect(card({ ...working, paymentCleared })).toEqual({ label: readiness.label, line: readiness.title });
    }
  });

  it("keeps the wording of a paused employee and of a change waiting for review", () => {
    const paused = deriveEmployeeReadiness({ ...base, enabled: false, paymentCleared: false });
    expect(card({ ...base, enabled: false, paymentCleared: false })).toEqual({ label: paused.label, line: paused.title });
    const review = deriveEmployeeReadiness({ ...base, configVersion: null, hasPendingReview: true, paymentCleared: true });
    expect(review.stage).toBe("review");
    expect(card({ ...base, configVersion: null, hasPendingReview: true, paymentCleared: true })).toEqual({ label: review.label, line: review.title });
  });

  it("keeps the readiness wording for a status that is not Setup required", () => {
    for (const status of ["provisioning", "offline", "error"] as const) {
      const input: EmployeeReadinessInput = { ...base, status, paymentCleared: true };
      const readiness = deriveEmployeeReadiness(input);
      expect(card(input)).toEqual({ label: readiness.label, line: readiness.title });
    }
    // An unpaid employee that is only being set up keeps the readiness sentence about the payment.
    expect(card({ ...base, status: "provisioning", paymentCleared: false }).line).toBe("Waiting for your setup payment");
    expect(PAYMENT_REQUIRED_SENTENCE).toContain("setup payment");
  });
});
