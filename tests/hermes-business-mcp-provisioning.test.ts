import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { buildInternalAgencyConfigYaml } from "@/server/workforce/provisioning";
import { MCP_TEST_SECRET } from "./support/business-mcp";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("internal Hermes business MCP profile configuration", () => {
  it("keeps the bridge off and MCP disabled by default", () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    resetEnvCache();

    const yaml = buildInternalAgencyConfigYaml();
    expect(yaml).toContain("- no_mcp");
    expect(yaml).not.toContain("mcp_servers:");
  });

  it("adds only the first-party endpoint when the separate read bridge switch is enabled", () => {
    vi.stubEnv("APP_URL", "https://portal.example.test");
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    resetEnvCache();

    const yaml = buildInternalAgencyConfigYaml();
    expect(yaml).toContain("- mcp-iacquire_business");
    expect(yaml).toContain("url: https://portal.example.test/api/internal/hermes-business/mcp");
    expect(yaml).toContain("tool_timeout: 12");
    expect(yaml).not.toContain("no_mcp");
    expect(yaml).not.toContain("sk-");
  });

  it("presents the dedicated business MCP credential, never the profile's API key, and never contains the signing secret", () => {
    vi.stubEnv("APP_URL", "https://portal.example.test");
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    resetEnvCache();

    const yaml = buildInternalAgencyConfigYaml();
    expect(yaml).toContain('Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"');
    expect(yaml).not.toContain("${API_SERVER_KEY}");
    expect(yaml).not.toContain(MCP_TEST_SECRET);
    expect(yaml).not.toMatch(/iamcp1\./);
  });
});
