// The automatic final checks must never start on their own for a client that was already using the product before they existed. They run only for a workspace whose onboarding finished on or
// after LAUNCH_AUTOMATION_SINCE, and run for no workspace while it is unset (the default): releasing the code starts nothing. The panel's own "run the checks" button is not part of that and
// keeps working for anyone who may use it. Test database only; nothing is sent, booked or contacted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { inAutomationScope, sweepLaunchVerification, sweepLaunchVerificationAfter } from "@/server/setup/launch-sweep";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { checkJobs, readyClient } from "./support/launch";

const since = (value: string) => {
  vi.stubEnv("LAUNCH_AUTOMATION_SINCE", value);
  resetEnvCache();
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("automatic final checks and the release date", () => {
  it("start nothing by themselves while no date is set, whatever the workspace, and the panel's own button still works", async () => {
    since("");
    const c = await readyClient({ name: "No Date Roofing", timezone: "Asia/Manila" });
    expect(await inAutomationScope(c.org.id)).toBe(false);
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    await sweepLaunchVerificationAfter(c.org.id, "a passing health check");
    expect(await checkJobs(c.org.id)).toBe(0);
    // The person who owns the workspace can still ask for the checks.
    const asked = await runLaunchIntent(c.ctx, "run_checks");
    expect(asked.ok).toBe(true);
    expect(await checkJobs(c.org.id)).toBeGreaterThan(0);
  }, 180_000);

  it("start for a workspace whose onboarding finished on or after the date, and not for one that finished before it", async () => {
    const after = await readyClient({ name: "After The Date Roofing", timezone: "Asia/Manila" });
    const before = await readyClient({ name: "Before The Date Roofing", timezone: "Asia/Manila" });
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() - interval '10 days' where id = $1", [before.org.id]));
    since(new Date(Date.now() - 5 * 24 * 3_600_000).toISOString());
    expect(await inAutomationScope(after.org.id)).toBe(true);
    expect(await inAutomationScope(before.org.id)).toBe(false);
    expect((await sweepLaunchVerification(before.org.id)).queued).toEqual([]);
    expect(await checkJobs(before.org.id)).toBe(0);
    expect((await sweepLaunchVerification(after.org.id)).queued.length).toBeGreaterThan(0);
    expect(await checkJobs(after.org.id)).toBeGreaterThan(0);
  }, 180_000);

  it("a date in the future includes nobody yet, and a malformed date is refused by the environment check", async () => {
    since("2999-01-01T00:00:00Z");
    const c = await readyClient({ name: "Future Date Roofing", timezone: "Asia/Manila" });
    expect(await inAutomationScope(c.org.id)).toBe(false);
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    since("next tuesday-ish");
    await expect(import("@/server/env").then((m) => m.env())).rejects.toThrow();
  }, 180_000);
});
