import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { buildInternalAgencyConfigYaml } from "@/server/workforce/provisioning";

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
    resetEnvCache();

    const yaml = buildInternalAgencyConfigYaml();
    expect(yaml).toContain("- mcp-iacquire_business");
    expect(yaml).toContain("url: https://portal.example.test/api/internal/hermes-business/mcp");
    expect(yaml).toContain('Authorization: "Bearer ${API_SERVER_KEY}"');
    expect(yaml).toContain("tool_timeout: 12");
    expect(yaml).not.toContain("no_mcp");
    expect(yaml).not.toContain("sk-");
  });
});
