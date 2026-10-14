import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createApproval, decideApproval, executeApproval, listApprovals } from "@/server/approvals/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let member: { id: string; email: string };

async function newApproval(kind: Parameters<typeof createApproval>[1]["kind"], risk: "low" | "medium" | "high" = "medium", extra: Record<string, unknown> = {}) {
  return withSystem((db) =>
    createApproval(db, {
      orgId: org.id,
      kind,
      title: `Test ${kind}`,
      action: extra,
      reason: "test",
      expectedEffect: "test",
      risk,
      requestedBy: owner.id,
    }),
  ) as Promise<string>;
}

async function state(id: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ status: string; execution_status: string; execution_detail: string | null }>(
      "select status, execution_status, execution_detail from approval_requests where id = $1",
      [id],
    ),
  );
  return rows[0];
}

beforeAll(async () => {
  org = await createOrg({ name: "Approval Co" });
  owner = await createUser();
  admin = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, member.id, "member");
});

describe("approval enforcement", () => {
  it("members cannot decide approvals", async () => {
    const id = await newApproval("knowledge_change", "low", { section: "faq", content: "x" });
    await expect(decideApproval(ctxFor(member, org, "member"), id, "approve")).rejects.toThrow(/owners and admins/);
    expect((await state(id)).status).toBe("pending");
  });

  it("high-risk approvals require the owner", async () => {
    const id = await newApproval("outreach", "high");
    await expect(decideApproval(ctxFor(admin, org, "admin"), id, "approve")).rejects.toThrow(/owner/);
    await decideApproval(ctxFor(owner, org, "owner"), id, "approve");
    const s = await state(id);
    expect(s.status).toBe("approved");
    // Messaging is never sent without a verified integration.
    expect(s.execution_status).toBe("blocked");
  });

  it("executes an approved knowledge change exactly once under concurrent clicks", async () => {
    const id = await newApproval("knowledge_change", "low", { section: "faq", content: "Q: Do you work weekends? A: Saturdays only." });
    const ctx = ctxFor(owner, org, "owner");
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => decideApproval(ctx, id, "approve")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => /already decided/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    const s = await state(id);
    expect(s.execution_status).toBe("succeeded");
    const { rows } = await withSystem((db) =>
      db.query<{ n: number }>("select count(*)::int as n from approval_events where approval_id = $1 and event = 'execution_started'", [id]),
    );
    expect(rows[0].n).toBe(1);
    // A second execution attempt after success is a no-op.
    expect(await executeApproval(org.id, id, owner.id)).toBeNull();
  });

  it("rejected approvals are never executed", async () => {
    const id = await newApproval("knowledge_change", "low", { section: "policies", content: "Should not apply" });
    await decideApproval(ctxFor(owner, org, "owner"), id, "reject");
    expect(await executeApproval(org.id, id, owner.id)).toBeNull();
    const { rows } = await withSystem((db) =>
      db.query("select 1 from company_knowledge where org_id = $1 and section = 'policies'", [org.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("expired approvals cannot be approved", async () => {
    const id = await newApproval("knowledge_change", "low", { section: "brand_voice", content: "late" });
    await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 minute' where id = $1", [id]));
    await expect(decideApproval(ctxFor(owner, org, "owner"), id, "approve")).rejects.toThrow(/expired/);
    expect((await state(id)).status).toBe("expired");
  });

  it("request changes requires a note", async () => {
    const id = await newApproval("crm_update", "medium");
    await expect(decideApproval(ctxFor(owner, org, "owner"), id, "request_changes")).rejects.toThrow(/what should change/);
    await decideApproval(ctxFor(owner, org, "owner"), id, "request_changes", "Use the new stage name");
    expect((await state(id)).status).toBe("changes_requested");
  });

  it("CRM updates stay blocked without an enabled CRM write integration", async () => {
    const id = await newApproval("crm_update", "medium");
    await decideApproval(ctxFor(owner, org, "owner"), id, "approve");
    const s = await state(id);
    expect(s.execution_status).toBe("blocked");
    expect(s.execution_detail).toMatch(/Nothing was changed/);
  });

  it("approvals from another tenant are invisible and undecidable", async () => {
    const other = await createOrg();
    const otherOwner = await createUser();
    await addMember(other.id, otherOwner.id, "owner");
    const id = await newApproval("crm_update", "low");
    const list = await listApprovals(ctxFor(otherOwner, other, "owner"), "all");
    expect(list.find((a) => a.id === id)).toBeUndefined();
    await expect(decideApproval(ctxFor(otherOwner, other, "owner"), id, "approve")).rejects.toThrow(/not found/);
  });
});
