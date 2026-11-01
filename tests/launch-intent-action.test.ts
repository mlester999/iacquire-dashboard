// The server action behind the launch panel's buttons. A server action can be called directly, so the parameters it accepts are checked here and nowhere else: a person's id (a uuid),
// the digest of the hours that were shown (64 lowercase hex digits), and nothing more. The service itself is replaced by a recorder, so this proves what reaches it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLaunchIntent: vi.fn(async (_ctx: unknown, _intent: string, _params: unknown) => ({ ok: true, message: "ok" })),
  requireOrgContextOrThrow: vi.fn(async (_permission: string) => ({ org: { orgId: "o" }, user: { id: "u" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: vi.fn() }) }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContextOrThrow: mocks.requireOrgContextOrThrow }));
vi.mock("@/server/calendars/connections", () => ({ CALENDAR_NOTICE_COOKIE: "n", CALENDAR_NOTICE_COOKIE_OPTIONS: { path: "/" } }));
vi.mock("@/server/setup/launch-intents", () => ({ runLaunchIntent: mocks.runLaunchIntent }));

import { runLaunchIntentAction } from "@/app/actions/launch-readiness";

const UUID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "ab".repeat(32);

beforeEach(() => {
  mocks.runLaunchIntent.mockClear();
  mocks.requireOrgContextOrThrow.mockClear();
});

describe("what the launch action accepts with a step", () => {
  it("passes a person's id and an approved hours digest through to the service, unchanged", async () => {
    expect(await runLaunchIntentAction("assign_host", { userId: UUID })).toMatchObject({ ok: true });
    expect(mocks.runLaunchIntent).toHaveBeenLastCalledWith(expect.anything(), "assign_host", { userId: UUID });
    expect(await runLaunchIntentAction("apply_hours", { hoursDigest: DIGEST })).toMatchObject({ ok: true });
    expect(mocks.runLaunchIntent).toHaveBeenLastCalledWith(expect.anything(), "apply_hours", { hoursDigest: DIGEST });
    expect(await runLaunchIntentAction("run_checks")).toMatchObject({ ok: true });
    expect(mocks.runLaunchIntent).toHaveBeenLastCalledWith(expect.anything(), "run_checks", {});
    expect(mocks.requireOrgContextOrThrow).toHaveBeenCalledWith("setup.view");
  });

  it("refuses a person who is not a uuid, a digest that is not 64 lowercase hex digits and any other key, before the service is reached", async () => {
    const bad: Array<[string, { userId?: string; hoursDigest?: string } & Record<string, unknown>]> = [
      ["a made-up person", { userId: "not-a-person" }],
      ["an empty person", { userId: "" }],
      ["a short digest", { hoursDigest: "abc123" }],
      ["an upper-case digest", { hoursDigest: "AB".repeat(32) }],
      ["a digest with other characters", { hoursDigest: "zz".repeat(32) }],
      ["an unknown key", { userId: UUID, calendarId: UUID }],
      ["a smuggled field", { hoursDigest: DIGEST, public: true }],
    ];
    for (const [label, extra] of bad) {
      const res = await runLaunchIntentAction("assign_host", extra);
      expect(res, label).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(mocks.runLaunchIntent).not.toHaveBeenCalled();
    expect(mocks.requireOrgContextOrThrow).not.toHaveBeenCalled();
  });

  it("refuses a step it does not know", async () => {
    expect(await runLaunchIntentAction("turn_on_public_page")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.runLaunchIntent).not.toHaveBeenCalled();
  });
});
