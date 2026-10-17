import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKED_TOOLSETS,
  DEFAULT_CLIENT_CAPABILITIES,
  HERMES_POLICY_CAPABILITIES,
  type HermesPolicyRecord,
} from "@/server/workforce/tool-policies";
import { resolveEffectiveHermesPolicy } from "@/lib/hermes-tool-policies";
import { buildConfigYaml } from "@/server/workforce/provisioning";

const policy = (id: string, name: string): HermesPolicyRecord => ({
  id,
  scopeKind: "client_default",
  orgId: null,
  agentId: null,
  name,
  allowedCapabilities: ["client_crm_read"],
  blockedToolsets: ["terminal", "file"],
  approvalMode: "client_rules",
  acknowledgedFullCapabilities: false,
  acknowledgedBy: null,
  acknowledgedAt: null,
  enforcementStatus: "not_enforced",
  updatedBy: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("Hermes tool-policy defaults and enforcement boundaries", () => {
  it("keeps Managed Automation business-scoped and blocks high-risk toolsets by default", () => {
    expect(DEFAULT_CLIENT_CAPABILITIES).toContain("client_crm_read");
    expect(DEFAULT_CLIENT_CAPABILITIES).toContain("authorized_booking");
    expect(DEFAULT_CLIENT_CAPABILITIES).not.toContain("image_generation");
    expect(DEFAULT_CLIENT_CAPABILITIES).not.toContain("video_generation");
    expect(DEFAULT_BLOCKED_TOOLSETS).toContain("terminal");
    expect(DEFAULT_BLOCKED_TOOLSETS).toContain("file");
    expect(DEFAULT_BLOCKED_TOOLSETS).toContain("browser");
    expect(DEFAULT_BLOCKED_TOOLSETS).toContain("delegation");
    expect(HERMES_POLICY_CAPABILITIES.some((option) => option.key === "client_crm_write")).toBe(true);
  });

  it("resolves employee overrides before client and default policies", () => {
    const inherited = policy("default", "Managed Automation");
    const client = { ...policy("client", "Custom client"), scopeKind: "client" as const, orgId: "client-id" };
    const employee = { ...policy("agent", "Custom employee"), scopeKind: "agent" as const, agentId: "agent-id" };
    expect(resolveEffectiveHermesPolicy({ clientDefault: inherited, clientOverride: client, agentOverride: employee })).toBe(employee);
    expect(resolveEffectiveHermesPolicy({ clientDefault: inherited, clientOverride: client })).toBe(client);
    expect(resolveEffectiveHermesPolicy({ clientDefault: inherited })).toBe(inherited);
  });

  it("emits sandboxed client provisioning settings and rejects unknown toolsets", () => {
    const yaml = buildConfigYaml(["terminal", "file"]);
    expect(yaml).toContain("    - terminal");
    expect(yaml).toContain("    - file");
    expect(yaml).toContain("backend: docker");
    expect(() => buildConfigYaml(["arbitrary_plugin"])).toThrow(/unsupported toolset/);
  });
});
