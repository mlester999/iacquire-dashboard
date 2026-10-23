// The portal shell tells the menu which modules a Super Admin has switched on for the signed-in workspace, so a module that is off is not offered. It is navigation only: every page
// and action checks the switch again (tests/proposals-service.test.ts and tests/proposals-actions.test.ts).
import { describe, expect, it } from "vitest";
import { getShellData } from "@/server/queries/shell";
import { CRM_ROLES } from "./support/crm";
import { ctxFor } from "./support/fixtures";
import { proposalOrg, setFeature, type ProposalOrg } from "./support/proposals";

const shellFor = (p: ProposalOrg, who: keyof typeof CRM_ROLES = "owner") => getShellData(ctxFor(p.people[who], p.org, CRM_ROLES[who]));

describe("the modules listed in the shell", () => {
  it("lists a module only while it is switched on for this workspace", async () => {
    const p = await proposalOrg({ feature: false });
    expect((await shellFor(p)).features).toEqual([]);
    await setFeature(p.org.id, true);
    expect((await shellFor(p)).features).toEqual(["proposals"]);
    await setFeature(p.org.id, true, "esign");
    expect((await shellFor(p)).features).toEqual(["esign", "proposals"]);
    await setFeature(p.org.id, false);
    expect((await shellFor(p)).features).toEqual(["esign"]);
  });

  it("never lists another workspace's modules", async () => {
    const on = await proposalOrg();
    const off = await proposalOrg({ feature: false });
    expect((await shellFor(on)).features).toEqual(["proposals"]);
    expect((await shellFor(off)).features).toEqual([]);
  });

  it("lists them for every role in the workspace: whether the person may use the module is the permission's job, not the list's", async () => {
    const p = await proposalOrg();
    for (const who of Object.keys(CRM_ROLES) as Array<keyof typeof CRM_ROLES>) expect((await shellFor(p, who)).features, who).toEqual(["proposals"]);
  });
});
