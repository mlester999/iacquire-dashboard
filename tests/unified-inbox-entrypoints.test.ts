import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { createClientTenant } from "@/server/admin/tenants";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { inboxEnabledFor, listRollout, setWorkspaceRollout, workspaceInboxOn } from "@/server/messaging/inbox-rollout";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { applyOperations } from "@/lib/crm/workflow/operations";
import { validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { agencyUser, createUser, uid } from "./support/fixtures";
import { messagingOrg } from "./support/messaging";

// The rollout cannot be walked around. Two kinds of check: a static audit of who can reach the code only the new inbox uses (a new caller has to be
// classified here on purpose), and behaviour through the other doors: workspace creation, workflow publishing, approval, turning on and the builder.

beforeAll(() => {
  delete process.env.INBOX_DISABLED;
  resetEnvCache();
});

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
const SOURCE = walk("src").map((file) => ({ file, text: read(file) }));
const defines = (name: string) => new RegExp(`export (async )?function ${name}\\b`);
const usedBy = (name: string) => {
  const use = new RegExp(`\\b${name}\\b`);
  const definers = SOURCE.filter((s) => defines(name).test(s.text)).map((s) => s.file);
  return { definers, users: SOURCE.filter((s) => use.test(s.text) && !definers.includes(s.file)).map((s) => s.file).sort() };
};

const ACTIONS = "src/app/actions/inbox.ts";
const PAGE = "src/app/(portal)/inbox/page.tsx";
const ROUTE = (p: string) => `src/app/api/inbox/${p}/route.ts`;
/** Each service function only the new inbox uses, and the only files that may call it. */
const ENTRY_POINTS: Record<string, { module: string; callers: string[] }> = {
  pauseAi: { module: "src/server/messaging/ai-control.ts", callers: [ACTIONS] },
  assignAiEmployee: { module: "src/server/messaging/ai-control.ts", callers: [ACTIONS] },
  transferConversation: { module: "src/server/messaging/ai-control.ts", callers: [ACTIONS] },
  retryFailedMessage: { module: "src/server/messaging/inbox.ts", callers: [ACTIONS] },
  markConversationUnread: { module: "src/server/messaging/inbox.ts", callers: [ACTIONS] },
  bulkUpdateConversations: { module: "src/server/messaging/inbox.ts", callers: [ACTIONS] },
  createTaskFromConversation: { module: "src/server/messaging/inbox-context.ts", callers: [ACTIONS] },
  createDealFromConversation: { module: "src/server/messaging/inbox-context.ts", callers: [ACTIONS] },
  addContactNoteFromConversation: { module: "src/server/messaging/inbox-context.ts", callers: [ACTIONS] },
  setLeadStatusFromConversation: { module: "src/server/messaging/inbox-context.ts", callers: [ACTIONS] },
  summarizeConversation: { module: "src/server/messaging/inbox-ai.ts", callers: [ROUTE("conversations/[id]/assist")] },
  suggestReply: { module: "src/server/messaging/inbox-ai.ts", callers: [ROUTE("conversations/[id]/assist")] },
  inboxSync: { module: "src/server/messaging/inbox-sync.ts", callers: [PAGE, ROUTE("sync")] },
  loadInboxThread: { module: "src/server/messaging/inbox-sync.ts", callers: [PAGE, ROUTE("conversations/[id]")] },
  listConversationAiEmployees: { module: "src/server/messaging/inbox-context.ts", callers: [PAGE] },
  getChannelHealth: { module: "src/server/messaging/channel-health.ts", callers: [PAGE] },
  // The page and the list route, and the older whole-list read the previous screen uses, which is built on it and has no new data of its own.
  listConversationsPage: { module: "src/server/messaging/inbox-list.ts", callers: [PAGE, ROUTE("conversations"), "src/server/messaging/inbox.ts"] },
  // The workflow step: its executor checks the rollout before it calls this.
  applyConversationAction: { module: "src/server/messaging/workflow-actions.ts", callers: ["src/server/crm/workflows/executors.ts"] },
};

describe("who can reach what only the new inbox uses", () => {
  it("is exactly the entry points that check the rollout (a new caller must be added here on purpose)", () => {
    for (const [name, { module, callers }] of Object.entries(ENTRY_POINTS)) {
      const { definers, users } = usedBy(name);
      expect(definers, `${name} is defined in ${module}`).toEqual([module]);
      expect(users, `callers of ${name}`).toEqual([...callers].sort());
    }
  });

  it("checks the rollout in every one of those entry points, and in the right place", () => {
    const actions = read(ACTIONS);
    expect((actions.match(/assertInboxEnabledFor\(ctx\.org\.orgId\)/g) ?? []).length).toBeGreaterThanOrEqual(11); // ten new-only actions and the mixed one
    expect(read(PAGE)).toMatch(/inboxEnabledFor\(ctx\.org\.orgId\)\)\) return <LegacyInbox/);
    for (const p of ["sync", "conversations", "conversations/[id]", "conversations/[id]/context", "conversations/[id]/assist", "escalations"]) {
      const route = read(ROUTE(p));
      expect(route, p).toContain("assertInboxEnabled()");
      expect(route, p).toContain("assertInboxEnabledFor(");
      // After the sign-in and permission check (so nothing about a workspace's rollout is told to a stranger), before any inbox data is read.
      expect(route.indexOf("requireOrgContextOrThrow"), p).toBeLessThan(route.indexOf("assertInboxEnabledFor("));
    }
    const executor = read("src/server/crm/workflows/executors.ts");
    expect(executor.indexOf("inboxEnabledFor(sc.org.id")).toBeGreaterThan(-1);
    expect(executor.indexOf("inboxEnabledFor(sc.org.id")).toBeLessThan(executor.indexOf("applyConversationAction(sc.db"));
  });

  it("is written by one module only: nothing else inserts, updates or deletes rollout rows", () => {
    const writers = SOURCE.filter((s) => /(insert into|update|delete from)\s+inbox_rollout\b/i.test(s.text)).map((s) => s.file);
    expect(writers).toEqual(["src/server/messaging/inbox-rollout.ts"]);
  });

  it("leaves the workflow doors to the one place that validates with the workspace's rollout", () => {
    // Every statement that creates or switches on a workflow outside the definitions service: blueprint import makes drafts only, approval re-validates.
    const writers = SOURCE.filter((s) => /insert into crm_workflows|update crm_workflows set status = 'active'/.test(s.text)).map((s) => s.file).sort();
    expect(writers).toEqual(["src/server/crm/blueprints/native-io/write.ts", "src/server/crm/workflows/approvals.ts", "src/server/crm/workflows/definitions.ts"]);
    expect(read("src/server/crm/blueprints/native-io/write.ts")).toMatch(/insert into crm_workflows[\s\S]{0,300}'draft'/);
    expect(read("src/server/crm/workflows/approvals.ts")).toContain("loadValidationContext(db, orgId)");
  });
});

describe("workspaces start with the new inbox off", () => {
  async function superAdmin() {
    const user = await createUser({ platformRole: "agency_super_admin", name: "Rollout Admin" });
    return agencyUser(user, "agency_super_admin");
  }

  it("when an agency member creates a client workspace through the real service", async () => {
    const admin = await superAdmin();
    const created = await createClientTenant(admin, { name: `Fresh Client ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, enabledRoles: ["lead_hunter"] });
    expect((await withSystem((db) => db.query("select 1 from inbox_rollout where org_id = $1", [created.orgId]))).rows).toHaveLength(0);
    expect(await workspaceInboxOn(created.orgId)).toBe(false);
    expect(await inboxEnabledFor(created.orgId)).toBe(false);
    const listed = (await listRollout(admin)).find((r) => r.orgId === created.orgId);
    expect(listed).toMatchObject({ enabled: false, kind: "client" });
  });

  it("for the internal agency workspace too: it is on the list, first, and off until a Super Admin switches it on", async () => {
    const admin = await superAdmin();
    const agencyId = await ensureAgencyWorkforceRegistry(admin);
    expect(await inboxEnabledFor(agencyId)).toBe(false);
    const rows = await listRollout(admin);
    expect(rows[0]).toMatchObject({ orgId: agencyId, kind: "agency", enabled: false });
    expect(await setWorkspaceRollout(admin, { orgId: agencyId, enabled: true, note: "Internal first" })).toMatchObject({ changed: true });
    expect(await inboxEnabledFor(agencyId)).toBe(true);
    await setWorkspaceRollout(admin, { orgId: agencyId, enabled: false });
  });
});

describe("the other doors for a workflow that uses the new inbox", () => {
  const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>): WorkflowStep => ({ key, kind, config, next: null }) as WorkflowStep;
  const idleWith = (tagId: string) => ({ trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [step("tag", "add_tag", { tagIds: [tagId] })] }) as unknown as WorkflowDefinition;
  const idle = { trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [step("tag", "add_tag", { tagIds: ["00000000-0000-4000-8000-000000000000"] })] } as unknown as WorkflowDefinition;

  it("cannot be turned on again after the workspace's inbox is switched off", async () => {
    const org = await messagingOrg({ name: "Re-enable Gate Co" });
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const actor = memberActor(org.ctx("owner"));
    const tag = await createTag(actor, { name: `Q${uid()}`, color: "#2563eb" });
    const { id } = await createWorkflow(actor, { name: "Went quiet tag", definition: idleWith(tag.id) });
    await publishWorkflow(actor, id);
    await setWorkflowStatus(actor, id, "active");
    await setWorkflowStatus(actor, id, "paused");
    await setWorkspaceRollout(admin, { orgId: org.org.id, enabled: false });
    await expect(setWorkflowStatus(actor, id, "active")).rejects.toThrow(/new inbox isn't switched on/);
    // Switching the inbox back on lets the same workflow be turned on.
    await setWorkspaceRollout(admin, { orgId: org.org.id, enabled: true });
    await expect(setWorkflowStatus(actor, id, "active")).resolves.toMatchObject({ status: "active" });
  });

  it("cannot be built in the Automation Studio builder: its options carry the workspace's rollout", async () => {
    const on = await messagingOrg({ name: "Builder On Co" });
    const off = await messagingOrg({ name: "Builder Off Co", inboxRollout: false });
    const base = { trigger: { type: "contact.created" }, steps: [] } as unknown as WorkflowDefinition;
    const build = async (orgId: string) => {
      const options = await withSystem((db) => loadBuilderOptions(db, orgId));
      const applied = applyOperations(base, [{ op: "set_trigger", trigger: { type: "conversation.idle", filters: { idleHours: [24] } } }], { mode: "strict", context: validationContextFrom(options) });
      return { inboxEnabled: options.inboxEnabled, applied };
    };
    const allowed = await build(on.org.id);
    expect(allowed.inboxEnabled).toBe(true);
    expect(allowed.applied.ok).toBe(true);
    // Strict mode (what the builder's chat uses) refuses the change itself where the workspace has not been switched on.
    const refused = await build(off.org.id);
    expect(refused.inboxEnabled).toBe(false);
    expect(refused.applied.ok).toBe(false);
    if (!refused.applied.ok) expect(refused.applied.error.message).toMatch(/new inbox isn't switched on/);
    // And a definition that already holds the trigger reports it as an error to the editor, the validator and the publisher.
    const issues = validateDefinition(idle, validationContextFrom(await withSystem((db) => loadBuilderOptions(db, off.org.id)))).filter((i) => i.level === "error").map((i) => i.code);
    expect(issues).toContain("inbox_not_enabled");
  });
});
