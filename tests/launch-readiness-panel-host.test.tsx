// @vitest-environment jsdom
// The host picker and the hours approval on the Setup panel, rendered. The founder's rule is that a host is never chosen for the client: nothing is selected at first, the button stays
// off until a person is picked, and the step carries exactly that person (or the digest of the hours that were shown) to the server action.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  // The panel asks for the state again after a step runs; here that read never answers, so nothing changes under the test.
  getLaunchReadinessAction: vi.fn(() => new Promise<never>(() => {})),
  dismissCalendarNoticeAction: vi.fn(async () => ({ ok: true as const })),
  runLaunchIntentAction: vi.fn(async (_intent: string, _params?: unknown) => ({ ok: true as const, data: { ok: true, message: "Done." } })),
}));
vi.mock("@/app/actions/launch-readiness", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/setup" }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import type { LaunchItem, LaunchReadiness } from "@/lib/launch-readiness";

const DIGEST = "a1".repeat(32);
const PEOPLE = [{ id: "11111111-1111-4111-8111-111111111111", name: "Dana Reyes" }, { id: "22222222-2222-4222-8222-222222222222", name: "Marcus Hale" }];

function panel(items: LaunchItem[]): LaunchReadiness {
  return {
    state: "action_required", label: "Action required", headline: "Action required", detail: "One thing needs you.", percent: 50, passed: 1, total: 2, blocking: [],
    steps: [{ key: "calendar", title: "Calendar and availability", state: "action_required", summary: "0 of 2 checks passed.", items }],
  };
}

const hostItem: LaunchItem = {
  key: "calendar.host", label: "Host", state: "action_required", required: true, owner: "you", detail: "Nobody hosts it yet.",
  action: { label: "Make me the host", intent: "assign_host" }, hostChoices: PEOPLE,
};
const hoursItem: LaunchItem = {
  key: "calendar.hours", label: "Host availability", state: "action_required", required: true, owner: "you", detail: "Your answers suggest Mon to Fri, 9:00 AM to 5:00 PM.",
  action: { label: "Approve these hours", intent: "apply_hours", params: { hoursDigest: DIGEST } },
};

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
beforeEach(() => actions.runLaunchIntentAction.mockClear());
afterEach(cleanup);

describe("the host picker", () => {
  it("starts with nobody selected and the button off, and lists exactly the people it was given", () => {
    render(<LaunchReadinessPanel readiness={panel([hostItem])} />);
    const select = screen.getByLabelText("Choose who takes appointments") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Choose a person", "Dana Reyes", "Marcus Hale"]);
    expect((screen.getByRole("button", { name: "Make them the host" }) as HTMLButtonElement).disabled).toBe(true);
    // Pressing the disabled button does nothing, and nothing runs on its own.
    fireEvent.click(screen.getByRole("button", { name: "Make them the host" }));
    expect(actions.runLaunchIntentAction).not.toHaveBeenCalled();
  });

  it("sends exactly the person picked, and only after one is picked", async () => {
    render(<LaunchReadinessPanel readiness={panel([hostItem])} />);
    fireEvent.change(screen.getByLabelText("Choose who takes appointments"), { target: { value: PEOPLE[1].id } });
    const button = screen.getByRole("button", { name: "Make them the host" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(actions.runLaunchIntentAction).toHaveBeenCalledTimes(1));
    expect(actions.runLaunchIntentAction).toHaveBeenCalledWith("assign_host", { userId: PEOPLE[1].id });
    // Going back to "Choose a person" turns the button off again.
    fireEvent.change(screen.getByLabelText("Choose who takes appointments"), { target: { value: "" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Make them the host" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("'Make me the host' carries no person, so the server uses the one who pressed it", async () => {
    render(<LaunchReadinessPanel readiness={panel([hostItem])} />);
    fireEvent.click(screen.getByRole("button", { name: "Make me the host: Host" }));
    await waitFor(() => expect(actions.runLaunchIntentAction).toHaveBeenCalledTimes(1));
    expect(actions.runLaunchIntentAction).toHaveBeenCalledWith("assign_host", undefined);
  });

  it("shows no select when the person has nobody to choose from, and runs nothing in the design preview", () => {
    render(<LaunchReadinessPanel readiness={panel([{ ...hostItem, hostChoices: undefined }])} />);
    expect(screen.queryByLabelText("Choose who takes appointments")).toBeNull();
    cleanup();
    render(<LaunchReadinessPanel readiness={panel([hostItem])} preview />);
    fireEvent.change(screen.getByLabelText("Choose who takes appointments"), { target: { value: PEOPLE[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "Make them the host" }));
    expect(actions.runLaunchIntentAction).not.toHaveBeenCalled();
  });
});

describe("approving the hours", () => {
  it("forwards the digest of the hours that were shown, and nothing else", async () => {
    render(<LaunchReadinessPanel readiness={panel([hoursItem])} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve these hours: Host availability" }));
    await waitFor(() => expect(actions.runLaunchIntentAction).toHaveBeenCalledTimes(1));
    expect(actions.runLaunchIntentAction).toHaveBeenCalledWith("apply_hours", { hoursDigest: DIGEST });
  });
});
