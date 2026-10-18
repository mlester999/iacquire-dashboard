import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { aqiError, classifyAqiError, providerAqiError } from "@/server/aqi/errors";

describe("AQi error classification", () => {
  it("gives clients friendly messages with no technical diagnostic", () => {
    const result = classifyAqiError(new AppError("integration_unavailable", "No AI provider is configured. A Super Admin must connect one."), { requestId: "req-1", superAdmin: false, reason: "provider_unavailable" });
    expect(result.code).toBe("temporarily_unavailable");
    expect(result.message).not.toMatch(/provider|Super Admin|API|database/i);
    expect(result.diagnostic).toBeUndefined();
  });

  it("gives Super Admins a safe structured diagnostic without raw error text", () => {
    const result = classifyAqiError(new AppError("integration_unavailable", "secret internal detail"), { requestId: "req-2", superAdmin: true, provider: "deepseek", model: "deepseek-flash", reason: "credential_unavailable" });
    expect(result.diagnostic).toMatchObject({ requestId: "req-2", internalCode: "integration_unavailable", provider: "deepseek", model: "deepseek-flash", reason: "credential_unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret internal detail");
  });

  it("maps rate and budget limits to truthful public messages", () => {
    expect(aqiError("rate_limited", { requestId: "r", superAdmin: false }).message).toMatch(/lot of requests/i);
    expect(aqiError("budget_exhausted", { requestId: "r", superAdmin: false }).message).toMatch(/usage limit/i);
    expect(providerAqiError("interrupted", { requestId: "r", superAdmin: false }).code).toBe("connection_interrupted");
  });
});
