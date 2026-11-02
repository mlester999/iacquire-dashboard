import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import type { RuntimeControlsData } from "@/components/admin/runtime-controls";

// Clearly labelled sample data for Bright Homes Roofing, a company that does not exist. The workspace id below is not a real workspace, so a press on any control is refused by the
// server; nothing here reads or changes any data.

export type RuntimeControlsPreviewView = "defaults" | "switched_on" | "no_profiles" | "none";
export const RUNTIME_CONTROLS_PREVIEW_VIEWS: readonly RuntimeControlsPreviewView[] = ["defaults", "switched_on", "no_profiles", "none"];

const SAMPLE_ORG = "00000000-0000-4000-8000-0000000000aa";

const employees = (hasProfile: boolean): RuntimeControlsData["employees"] => AGENT_ROLE_KEYS.map((role, i) => ({
  id: `00000000-0000-4000-8000-00000000010${i}`,
  name: AGENT_BY_KEY[role].name,
  // The sample plan leaves the Performance Analyst out: it is not shown a retry and has nothing to contain.
  enabled: role !== "performance_analyst",
  hasProfile: hasProfile && role !== "performance_analyst",
}));

/**
 * The four states a Super Admin meets: every deployment switch at its default (off), the switches on with the tiers on for this workspace, a workspace whose employees have no runtime
 * profile yet, and the page giving the component nothing (an agency's own workspace, a demo, or anyone who is not a Super Admin).
 */
export function runtimeControlsPreview(view: RuntimeControlsPreviewView): RuntimeControlsData | null {
  switch (view) {
    case "none":
      return null;
    case "no_profiles":
      return { orgId: SAMPLE_ORG, flags: { provisioner: true, deprovision: true, clientTools: true }, tiers: { tools: false, proposals: false }, employees: employees(false) };
    case "switched_on":
      return { orgId: SAMPLE_ORG, flags: { provisioner: true, deprovision: true, clientTools: true }, tiers: { tools: true, proposals: false }, employees: employees(true) };
    case "defaults":
    default:
      return { orgId: SAMPLE_ORG, flags: { provisioner: false, deprovision: false, clientTools: false }, tiers: { tools: false, proposals: false }, employees: employees(true) };
  }
}
