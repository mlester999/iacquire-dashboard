// The words a paying client's six employees are given are reviewed text: what each may do, what it may never do and when a person must approve. This test pins a sha256 of what ships for
// each CLIENT role (its profile SOUL, its compiled instruction template with the role's reviewed default tools, and the business tools its client tier offers) so that no edit to any of it
// reaches a client without being looked at again. The digests are deliberately not derived from the code at run time for the comparison: they are written down here AND in
// docs/client-role-texts-review-2026-11-01.md, and all three must agree.
//
// WHEN THIS FAILS: a client role text, a role's default tools or a client business tool changed. That needs the founder's review of the new wording. Read the diff, update the review
// document (the role's section and the digest lines), then copy the new digests below. Never update the pins just to make the test pass.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { buildSoul } from "@/server/workforce/provisioning";
import { CLIENT_NEVER_OFFERED_TOOLS, clientBusinessMcpToolNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { POLICY_VERSION } from "@/server/workforce/policy";

const DOC = readFileSync(join(resolve(__dirname, ".."), "docs/client-role-texts-review-2026-11-01.md"), "utf8");
const COMPANY = "Example Company";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The pinned digest of each role and of all six together, in the order of AGENT_ROLE_KEYS. */
const PINNED: Record<AgentRoleKey, string> = {
  operations_manager: "837a54f050db0ac54feb83f49f353cf066a73e464f1aa84831b537b0a4ce1dc0",
  lead_hunter: "bb251351c5ab64be1c9050ba57474feaf65b3c27289de994047bfd9891cbb09c",
  appointment_setter: "cd7e1b5862ee1435f1cc2d6c78d5d2652ed46c54395397d49eab2c0c1059fde2",
  sales_assistant: "27c8f16566ee9d6ff95bdc28348c98aa1bb253febad9b04e024d74445da69724",
  crm_manager: "a5218289e03318183438661af6c412f0f3f152ed276716339d2ddac5c8259f08",
  performance_analyst: "9ed8221d68c6b0cf4b52e7bcae3c92b7a71b941e04815e91f3cfca869a502dca",
};
const PINNED_OVERALL = "1cda38097eb81025e5211c68dc9ad2e374cdb5a4db8c8fed50fd73a90cac0320";

async function shipped() {
  const { rows } = await withSystem((db) => db.query<{ key: string; default_tools: string[] }>("select key, default_tools from agent_roles"));
  const toolsOf = new Map(rows.map((r) => [r.key, r.default_tools]));
  const perRole = {} as Record<AgentRoleKey, string>;
  for (const role of AGENT_ROLE_KEYS) {
    const tools = toolsOf.get(role);
    if (!tools) throw new Error(`the role ${role} has no reference row`);
    const text = JSON.stringify({
      soul: buildSoul(role, COMPANY, "client"),
      // Version 1 and the role's own default settings: the template a client starts from, before any answer is added.
      instructions: compileAgentConfig({ role, settings: defaultSettings(role), company: { companyName: COMPANY, orgKind: "client" }, version: 1, allowedTools: tools }).instructions,
      portalTools: tools,
      businessReads: clientBusinessMcpToolNamesForRole(role),
      businessProposals: clientBusinessMcpToolNamesForRole(role, { proposals: true }).filter((name) => !clientBusinessMcpToolNamesForRole(role).includes(name)),
    });
    perRole[role] = sha256(text);
  }
  return { perRole, overall: sha256(AGENT_ROLE_KEYS.map((role) => `${role}:${perRole[role]}`).join("\n")) };
}

describe("the client role texts are pinned and reviewed", () => {
  it("every shipped client role text matches its pinned digest", async () => {
    const { perRole, overall } = await shipped();
    expect(perRole, "A client role text changed. It needs the founder's review: see the note at the top of this file.").toEqual(PINNED);
    expect(overall).toBe(PINNED_OVERALL);
  });

  it("the review document carries the same digests", async () => {
    const { perRole, overall } = await shipped();
    for (const role of AGENT_ROLE_KEYS) {
      expect(DOC, `the review document has no digest line for ${role}`).toMatch(new RegExp(`^- ${role}: ([0-9a-f]{64})$`, "m"));
      expect(DOC.match(new RegExp(`^- ${role}: ([0-9a-f]{64})$`, "m"))?.[1], `the review document's digest for ${role} is stale`).toBe(perRole[role]);
    }
    expect(DOC.match(/^- overall: ([0-9a-f]{64})$/m)?.[1], "the review document's overall digest is stale").toBe(overall);
  });

  it("the review document states the policy version and names every business tool each role is offered, and the tools no client employee is ever offered", () => {
    expect(DOC).toContain(POLICY_VERSION);
    for (const role of AGENT_ROLE_KEYS) {
      expect(DOC, `the review document has no section for ${role}`).toContain(`\`${role}\``);
      for (const name of clientBusinessMcpToolNamesForRole(role, { proposals: true })) {
        expect(DOC, `the review document does not name the tool ${name} offered to ${role}`).toContain(`\`${name}\``);
      }
    }
    for (const name of CLIENT_NEVER_OFFERED_TOOLS) expect(DOC, `the review document does not say ${name} is never offered`).toContain(`\`${name}\``);
  });

  it("pins six distinct texts, so a role cannot silently inherit another's", async () => {
    const { perRole } = await shipped();
    expect(new Set(Object.values(perRole)).size).toBe(AGENT_ROLE_KEYS.length);
  });
});
