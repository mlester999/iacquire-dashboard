import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { mediaStorageStepDescription } from "@/server/setup/storage-step";
import { getMediaPolicy } from "@/server/social/media";
import { mediaStoragePolicy } from "@/lib/social/media-policy";
import { MEDIA_STORAGE_STEP_KEY, mediaStorageStepText } from "@/lib/onboarding/media-storage-step";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { socialOrg } from "./support/social";

// The optional media storage step (migration 0102) is a window onto the existing storage policy: the words are read from it each time, it needs nothing from the client, it
// completes nothing by itself and it is never a requirement.

async function client(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await ensureInstanceStandalone(org.id);
  return { org, owner, ctx: ctxFor(owner, org, "owner") };
}
const withPlan = (orgId: string, ownerId: string) =>
  withSystem((db) => db.query(
    "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
    [orgId, ownerId],
  ));
const stepOf = async (ctx: ReturnType<typeof ctxFor>) => (await getClientSetupSnapshot(ctx))!.tasks.find((t) => t.title === "Where your post pictures and videos are kept");

describe("the media storage step on a checklist", () => {
  it("is on every new checklist, optional, owned by iAcquire and not an activation step", async () => {
    const { org, ctx } = await client("Storage Step Co");
    const snap = await getClientSetupSnapshot(ctx);
    const step = snap!.tasks.find((t) => t.title === "Where your post pictures and videos are kept");
    expect(step).toMatchObject({ required: false, isActivation: false, status: "pending", section: "agency", action: null });
    const { rows } = await withSystem((db) => db.query<{ required: boolean; completion_mode: string; check_key: string | null; service: string | null; requires_client_response: boolean; client_action: unknown }>(
      "select required, completion_mode, check_key, service, requires_client_response, client_action from client_setup_tasks where org_id = $1 and template_key = $2", [org.id, MEDIA_STORAGE_STEP_KEY],
    ));
    expect(rows[0]).toEqual({ required: false, completion_mode: "manual", check_key: null, service: null, requires_client_response: false, client_action: null });
  });

  it("holds nothing back: it does not count toward the percentage and no other step waits for it", async () => {
    const { org, ctx } = await client("Not Counted Co");
    const snap = await getClientSetupSnapshot(ctx);
    const all = snap!.tasks.length;
    expect(snap!.progress.total).toBeLessThan(all);
    const { rows } = await withSystem((db) => db.query<{ n: string }>(
      `select count(*) as n from client_setup_template_tasks where $1 = any(depends_on)`, [MEDIA_STORAGE_STEP_KEY],
    ));
    expect(Number(rows[0].n)).toBe(0);
    const deps = await withSystem((db) => db.query(
      `select 1 from client_setup_task_dependencies d join client_setup_tasks t on t.id = d.depends_on_task_id where d.org_id = $1 and t.template_key = $2`, [org.id, MEDIA_STORAGE_STEP_KEY],
    ));
    expect(deps.rows).toHaveLength(0);
  });
});

describe("what the step tells a client", () => {
  it("without the managed plan: no storage yet, and why, read from the policy", async () => {
    const { ctx } = await client("No Plan Co");
    const expected = mediaStorageStepText(mediaStoragePolicy({ managedPlanActive: false, googleDriveConnected: false, onedriveConnected: false }));
    const step = await stepOf(ctx);
    expect(step!.description).toBe(expected);
    expect(step!.description).toContain("No media storage is available for this workspace yet");
    expect(step!.description).toContain("Included with the managed maintenance plan");
    expect(step!.description).toContain("Connecting Google Drive is not available yet");
    expect(step!.description).toContain("Connecting OneDrive is not available yet");
    expect(step!.description).toContain("This step is optional");
    // Never the sentence the template was created with, which promised storage "while you are on the managed maintenance plan" to everybody.
    expect(step!.description).not.toContain("kept in iAcquire storage while you are on");
  });

  it("with the managed plan: says iAcquire storage can be used, and still does not claim Google Drive or OneDrive", async () => {
    const { org, owner, ctx } = await client("Plan Co");
    await withPlan(org.id, owner.id);
    const step = await stepOf(ctx);
    expect(step!.description).toContain("Media can be added from iAcquire storage.");
    expect(step!.description).not.toContain("No media storage is available");
    expect(step!.description).not.toContain("Included with the managed maintenance plan");
    expect(step!.description).toContain("Connecting Google Drive is not available yet");
  });

  it("changes when the plan changes, because it is read every time, and never reaches the stored step", async () => {
    const { org, owner, ctx } = await client("Changing Co");
    const before = (await stepOf(ctx))!.description;
    await withPlan(org.id, owner.id);
    const after = (await stepOf(ctx))!.description;
    expect(after).not.toBe(before);
    const stored = await withSystem((db) => db.query<{ description: string }>("select description from client_setup_tasks where org_id = $1 and template_key = $2", [org.id, MEDIA_STORAGE_STEP_KEY]));
    expect(stored.rows[0].description).not.toBe(before);
    expect(stored.rows[0].description).not.toBe(after);
  });

  it("keeps two workspaces apart: one on the plan does not give the other storage", async () => {
    const a = await client("Storage A");
    const b = await client("Storage B");
    await withPlan(a.org.id, a.owner.id);
    expect((await stepOf(a.ctx))!.description).toContain("Media can be added from iAcquire storage.");
    expect((await stepOf(b.ctx))!.description).toContain("No media storage is available");
  });

  it("agrees with the social media library about the same workspace, with and without the plan", async () => {
    const s = await socialOrg();
    const text = () => withSystem((db) => mediaStorageStepDescription(db, s.m.org.id));
    expect(await text()).toBe(mediaStorageStepText(await getMediaPolicy(s.owner)));
    await withPlan(s.m.org.id, s.m.people.owner.id);
    expect(await text()).toBe(mediaStorageStepText(await getMediaPolicy(s.owner)));
    expect(await text()).toContain("Media can be added from iAcquire storage.");
  });
});

describe("the wording", () => {
  it("is built from the policy's own options and never invents a connected drive", () => {
    const text = mediaStorageStepText(mediaStoragePolicy({ managedPlanActive: false, googleDriveConnected: false, onedriveConnected: false }));
    expect(text.match(/not available yet/g)).toHaveLength(2);
    expect(text).not.toMatch(/connected to your/i);
    // A drive that WERE connected would be said: the text follows the policy, not a fixed sentence.
    const connected = mediaStorageStepText(mediaStoragePolicy({ managedPlanActive: false, googleDriveConnected: true, onedriveConnected: false }));
    expect(connected).toContain("Media can be added from Your Google Drive.");
  });
});
