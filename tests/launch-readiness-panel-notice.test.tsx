// @vitest-environment jsdom
// The one-time calendar sign-in notice on the Setup panel: it is shown, and the server is told to forget it exactly once, when the page was handed a notice. Rendered in a browser
// environment because the forgetting is an effect, which a static render never runs.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const actions = vi.hoisted(() => ({ dismissCalendarNoticeAction: vi.fn(async () => ({ ok: true as const })), runLaunchIntentAction: vi.fn() }));
vi.mock("@/app/actions/launch-readiness", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/setup" }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import type { LaunchReadiness } from "@/lib/launch-readiness";

const readiness: LaunchReadiness = {
  state: "action_required", label: "Action required", headline: "Action required", detail: "One thing needs you.", percent: 50, passed: 1, total: 2, blocking: [],
  steps: [{ key: "calendar", title: "Calendar and availability", state: "action_required", summary: "0 of 1 checks passed.", items: [{ key: "calendar.host", label: "Host", state: "action_required", required: true, detail: "Nobody hosts it yet.", owner: "you" }] }],
};

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  actions.dismissCalendarNoticeAction.mockClear();
});

describe("the calendar notice on the Setup panel", () => {
  it("shows the notice and tells the server to forget it once", () => {
    render(<LaunchReadinessPanel readiness={readiness} calendarNotice={{ ok: true, text: "Google is connected." }} />);
    expect(screen.getByText("Google is connected.")).toBeTruthy();
    expect(actions.dismissCalendarNoticeAction).toHaveBeenCalledTimes(1);
  });

  it("does not touch the cookie when there is no notice", () => {
    render(<LaunchReadinessPanel readiness={readiness} calendarNotice={null} />);
    render(<LaunchReadinessPanel readiness={readiness} />);
    expect(actions.dismissCalendarNoticeAction).not.toHaveBeenCalled();
  });

  it("does not forget a notice in the design preview, where nothing runs", () => {
    render(<LaunchReadinessPanel readiness={readiness} preview calendarNotice={{ ok: true, text: "Google is connected." }} />);
    expect(actions.dismissCalendarNoticeAction).not.toHaveBeenCalled();
  });
});
