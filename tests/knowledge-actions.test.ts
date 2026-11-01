// The server actions behind the Knowledge Center's History drawer: reading the history needs knowledge.view, restoring needs knowledge.edit, and a refusal writes nothing. Who is acting
// is chosen by the test (the session lookup is the only thing replaced); the permission check, the service and the database are the real ones.
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ctx: null as null | import("@/server/tenancy/context").OrgContext }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...mod,
    requireOrgContextOrThrow: async (permission?: import("@/lib/permissions").Permission) => {
      if (!h.ctx) throw new Error("No person chosen for this test.");
      if (permission && !h.ctx.can(permission)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
      return h.ctx;
    },
  };
});

import { withSystem } from "@/server/db";
import { loadKnowledgeHistoryAction, restoreKnowledgeRevisionAction, saveKnowledgeAction } from "@/app/actions/knowledge";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let viewer: { id: string; email: string };
let member: { id: string; email: string };

beforeAll(async () => {
  org = await createOrg({ name: "Knowledge Actions Co" });
  owner = await createUser();
  viewer = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, viewer.id, "viewer");
  await addMember(org.id, member.id, "member");
});

const as = (user: { id: string; email: string }, role: "owner" | "viewer" | "member") => {
  h.ctx = ctxFor(user, org, role);
};
const sectionRow = async () =>
  (await withSystem((db) => db.query<{ content: string; version: number }>("select content, version from company_knowledge where org_id = $1 and section = 'policies'", [org.id]))).rows[0];

describe("the history actions", () => {
  it("lets a person who may view read the history, and refuses restoring to anyone who may not edit", async () => {
    as(owner, "owner");
    expect(await saveKnowledgeAction("policies", "Refunds within 30 days. ONE")).toMatchObject({ ok: true });
    expect(await saveKnowledgeAction("policies", "Refunds within 14 days. TWO")).toMatchObject({ ok: true });
    const history = await loadKnowledgeHistoryAction("policies");
    expect(history.ok).toBe(true);
    const first = history.ok ? history.data.find((r) => r.content.includes("ONE")) : undefined;
    expect(first).toBeTruthy();

    for (const [user, role] of [[viewer, "viewer"], [member, "member"]] as const) {
      as(user, role);
      // A viewer may read the history (knowledge.view) ...
      if (role === "viewer") expect((await loadKnowledgeHistoryAction("policies")).ok).toBe(true);
      // ... and cannot restore (knowledge.edit): the action refuses and the section is untouched.
      const refused = await restoreKnowledgeRevisionAction("policies", first!.id);
      expect(refused).toMatchObject({ ok: false });
      expect(await sectionRow()).toMatchObject({ content: "Refunds within 14 days. TWO", version: 2 });
    }

    as(owner, "owner");
    expect(await restoreKnowledgeRevisionAction("policies", first!.id)).toEqual({ ok: true, data: { held: false } });
    expect(await sectionRow()).toMatchObject({ content: "Refunds within 30 days. ONE", version: 3 });
  });

  it("refuses everyone's history request when the person has no knowledge.view, and an unknown section", async () => {
    as(owner, "owner");
    expect(await loadKnowledgeHistoryAction("not_a_section")).toMatchObject({ ok: false });
    // A role without the permission is refused before the service runs.
    h.ctx = { ...ctxFor(owner, org, "owner"), can: () => false };
    expect(await loadKnowledgeHistoryAction("policies")).toMatchObject({ ok: false });
    expect(await restoreKnowledgeRevisionAction("policies", "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false });
  });
});
