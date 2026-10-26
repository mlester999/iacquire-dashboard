import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { isSetupPaymentClearedFor } from "@/server/billing/clearance";
import { setupPaymentLine } from "@/lib/onboarding/setup-payment-line";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

// The Setup payment line on a client's /setup shows the database's yes or no for the member asking (app.setup_payment_cleared), and nothing finer.

async function client(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, owner };
}
const lineFor = async (userId: string, orgId: string) => setupPaymentLine(await isSetupPaymentClearedFor(userId, orgId))?.state ?? null;

describe("the line follows the database", () => {
  it("waits while the fee is not confirmed, whatever the status in front of the payment", async () => {
    const { org, owner } = await client("Waiting Line Co");
    expect(await lineFor(owner.id, org.id)).toBe("waiting");
    for (const status of ["not_invoiced", "invoiced"]) {
      await withSystem((db) => db.query("insert into billing_accounts (org_id, setup_payment_status) values ($1, $2) on conflict (org_id) do update set setup_payment_status = excluded.setup_payment_status", [org.id, status]));
      expect(await lineFor(owner.id, org.id)).toBe("waiting");
    }
  });

  it("is confirmed once the fee is cleared, and the client is not told which way", async () => {
    const { org, owner } = await client("Confirmed Line Co");
    await clearSetupPayment(org.id);
    expect(await lineFor(owner.id, org.id)).toBe("confirmed");
    const line = setupPaymentLine(true)!;
    expect(`${line.title} ${line.detail}`).not.toMatch(/waiv|reason|refund/i);
  });

  it("a member of another workspace is never told this workspace's answer", async () => {
    const a = await client("Line A");
    const b = await client("Line B");
    await clearSetupPayment(a.org.id);
    expect(await lineFor(a.owner.id, a.org.id)).toBe("confirmed");
    expect(await lineFor(b.owner.id, a.org.id)).toBe("waiting");
    expect(await lineFor(b.owner.id, b.org.id)).toBe("waiting");
  });
});

describe("the page", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "src/app/(portal)/setup/page.tsx"), "utf8");

  it("asks the database on every visit, so an address like ?onboarded=1 cannot make it claim anything", () => {
    const asked = source.split("\n").find((l) => l.includes("isSetupPaymentClearedFor(") && l.includes("const paymentCleared"));
    expect(asked).toBeTruthy();
    expect(asked).not.toContain("onboarded");
    expect(source).toContain("<SetupPaymentLine cleared={paymentCleared}");
  });

  it("gives the billing link only to someone who may see billing", () => {
    expect(source).toMatch(/billingHref=\{ctx\.can\("billing\.view"\) \? "\/settings\/billing" : null\}/);
  });
});
