// @vitest-environment jsdom
// The showroom's two folding surfaces, clicked through: the navigation rail that folds into a rail of icons (and remembers which, in this browser), and AQi, the floating button that
// opens a panel over the page and tucks it away again without losing what was typed. The server is replaced by a recorder: none of the controls may send a message by themselves.
// The animation and the layout at 375, 1280 and 1600 px are for the lead's browser pass; here are the labels, roles, states, focus and calls.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/demo/room",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});

import { Workspace, type WorkspaceProps } from "@/components/demo/showroom/workspace";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import { scenarioFor } from "@/lib/demo/showroom/industry";

const FALLBACK = "00000000-0000-4000-8000-000000000000";
const state: WorkspaceProps["state"] = {
  firstName: "Avery",
  business: "Harborview",
  industryLabel: null,
  scenario: scenarioFor(null),
  access: "open",
  windowEndsAt: null,
  extended: false,
  messagesLeft: 9,
  messageAllowance: 10,
  aiEnabled: true,
  consultationRequested: false,
  consultationUrl: null,
  purchaseStarted: false,
  setupFeeUsd: SETUP_FEE_USD,
  monthlyPlanUsd: MAINTENANCE_MONTHLY_USD,
  plan: { included: null, monthlyRequestAllowance: null },
  ctaNotice: null,
  initialConfirm: null,
};
const chat: WorkspaceProps["chat"] = {
  initial: { transcript: [], messagesLeft: 9, messageAllowance: 10, canSend: true, refusalMessage: null },
  fallbackMessageId: FALLBACK,
  pageNotice: null,
  show: true,
};

const fetchMock = vi.fn();
/** Pretends the browser is a phone (true) or a larger screen (false) for the one media query the workspace asks. */
function screenIs(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({ matches: phone && query.includes("639"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  screenIs(false);
  window.localStorage.clear();
  window.history.replaceState(null, "", "/demo/room?view=crm");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function room(over: Partial<WorkspaceProps> = {}) {
  return render(<Workspace initialView="crm" state={state} chat={chat} {...over} />);
}
const rail = () => screen.getByRole("complementary", { name: "Demo navigation" });
const sections = () => within(within(rail()).getByRole("navigation", { name: "Sections" }));
const launcher = () => screen.getByRole("button", { name: /^Open AQi/ });
const panel = () => document.getElementById("showroom-chat")!;
const question = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("the navigation rail", () => {
  it("folds into a rail of icons and back, keeps every link, and remembers the choice in this browser", () => {
    const { container } = room();
    const layout = container.querySelector(".showroom-layout") as HTMLElement;
    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("demo-rail");
    expect(rail().getAttribute("data-collapsed")).toBe("false");
    expect(layout.style.getPropertyValue("--sidebar-w")).toBe("264px");

    const links = () => sections().getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    const open = links();
    expect(open.map(([name]) => name)).toEqual(["Overview", "AI Workforce", "CRM & Pipeline", "Inbox & Appointments", "Automation Studio", "Reports & Insights", "Plans & Pricing", "Why iAcquireOS?"]);
    expect(open[0][1]).toBe("/demo/room");
    expect(open[5][1]).toBe("/demo/room?view=reports");

    fireEvent.click(toggle);
    // The same button is still there (so the focus stays on it), now offering the opposite.
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rail().getAttribute("data-collapsed")).toBe("true");
    expect(layout.getAttribute("data-nav-collapsed")).toBe("true");
    expect(layout.style.getPropertyValue("--sidebar-w")).toBe("68px");
    expect(window.localStorage.getItem("iaq-demo-nav-v1")).toBe("compact");
    // Folding takes nothing away: every row still has its words (a tooltip shows them) and goes where it went.
    expect(links()).toEqual(open);

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toBe(toggle);
    expect(rail().getAttribute("data-collapsed")).toBe("false");
    expect(layout.style.getPropertyValue("--sidebar-w")).toBe("264px");
    expect(window.localStorage.getItem("iaq-demo-nav-v1")).toBe("full");
  });

  it("opens folded when it was left folded, and ignores anything it did not write", () => {
    window.localStorage.setItem("iaq-demo-nav-v1", "compact");
    room();
    expect(rail().getAttribute("data-collapsed")).toBe("true");
    cleanup();
    window.localStorage.setItem("iaq-demo-nav-v1", "<script>");
    room();
    expect(rail().getAttribute("data-collapsed")).toBe("false");
  });

  it("still folds for the visit when the browser will not keep the choice", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    room();
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(rail().getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(rail().getAttribute("data-collapsed")).toBe("false");
  });

  it("marks the section the visitor is on, folded or not, and moves there without leaving the page", () => {
    room();
    expect(sections().getByRole("link", { name: "CRM & Pipeline" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    fireEvent.click(sections().getByRole("link", { name: "Reports & Insights" }));
    expect(sections().getByRole("link", { name: "Reports & Insights" }).getAttribute("aria-current")).toBe("page");
    expect(sections().getByRole("link", { name: "CRM & Pipeline" }).getAttribute("aria-current")).toBeNull();
    expect(window.location.search).toBe("?view=reports");
    expect(rail().getAttribute("data-collapsed")).toBe("true");
  });

  it("shows the window and the message count as small tiles when folded, in words for a screen reader", () => {
    room();
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    const glance = within(rail()).getByRole("group", { name: "Your demo at a glance" });
    expect(glance.textContent).toContain("9 of 10 AI messages left");
  });
});

describe("AQi", () => {
  it("is a floating button; the panel is out of the way until it opens, and closing it never loses a question", async () => {
    room();
    const button = launcher();
    // Its name begins with the words drawn on it ("AQi", "9 left"), so a visitor who speaks to their device can press it by what they see.
    expect(button.getAttribute("aria-label")).toBe("Open AQi, 9 left");
    expect(button.getAttribute("title")).toBe("Open AQi, the demo guide. 9 of 10 messages left.");
    expect(button.textContent).toBe("AQi 9 left");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("showroom-chat");
    // Closed: hidden from assistive technology and from the keyboard, but still in the page, so nothing in it is thrown away.
    expect(panel().getAttribute("aria-hidden")).toBe("true");
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("complementary", { name: "AQi demo guide" })).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("aria-hidden")).toBe(false);
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("complementary", { name: "AQi demo guide" })).toBe(panel());
    expect(within(panel()).getByRole("heading", { name: /AQi/ })).toBeTruthy();
    // The focus goes to the question box, so a visitor can type at once.
    await waitFor(() => expect(document.activeElement).toBe(question()));

    fireEvent.change(question(), { target: { value: "My unfinished question" } });
    fireEvent.click(screen.getByRole("button", { name: "Close AQi" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel().getAttribute("aria-hidden")).toBe("true");
    // The focus goes back to the button that opened it.
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(question().value).toBe("My unfinished question");

    fireEvent.click(button);
    expect(question().value).toBe("My unfinished question");
    // Escape inside the panel closes it too.
    fireEvent.keyDown(question(), { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not take the focus just because the page loaded (React runs every effect twice on mount while developing)", async () => {
    render(
      <React.StrictMode>
        <Workspace initialView="crm" state={state} chat={chat} />
      </React.StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.activeElement).toBe(document.body);
  });

  it("opens by itself only when the page has something to say about the visitor's last message", () => {
    room({ chat: { ...chat, pageNotice: { tone: "error", text: "That message was not counted." } } });
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("aria-hidden")).toBe(false);
  });

  it("opens from a suggested question and puts the question in the box without sending it", async () => {
    room({ initialView: "reports" });
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Ask how the weekly note works" }));
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    expect(question().value).toBe("How does the Performance Analyst decide what to put in the weekly note?");
    await waitFor(() => expect(document.activeElement).toBe(question()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays open when the visitor moves between sections on a large screen, and tucks itself away on a phone", () => {
    room();
    fireEvent.click(launcher());
    fireEvent.click(sections().getByRole("link", { name: "Reports & Insights" }));
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    cleanup();

    screenIs(true);
    room();
    fireEvent.click(launcher());
    fireEvent.click(sections().getByRole("link", { name: "Reports & Insights" }));
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the launcher, the rail and the conversation agreeing on how many messages are left", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        ok: true,
        kind: "answered",
        room: {
          transcript: [
            { id: "1", seq: 1, role: "user", employeeRole: null, body: "What do you do?", state: "answered", at: "2026-11-02T09:00:00.000Z" },
            { id: "2", seq: 2, role: "assistant", employeeRole: null, body: "Here is the answer.", state: null, at: "2026-11-02T09:00:05.000Z" },
          ],
          messagesLeft: 8,
          messageAllowance: 10,
          chat: { canSend: true, refusalMessage: null },
        },
      }),
    );
    room();
    fireEvent.click(launcher());
    fireEvent.change(question(), { target: { value: "What do you do?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(screen.getByText("Here is the answer.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(screen.getByText("8 of 10 messages left")).toBeTruthy();
    expect(launcher().getAttribute("aria-label")).toBe("Open AQi, 8 left");
    expect(launcher().getAttribute("title")).toBe("Open AQi, the demo guide. 8 of 10 messages left.");
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(within(rail()).getByRole("group", { name: "Your demo at a glance" }).textContent).toContain("8 of 10 AI messages left");
  });

  it("is only a plain notice, with no box to type in, when the demo's AI is off", () => {
    room({
      state: { ...state, aiEnabled: false },
      chat: { initial: { transcript: [], messagesLeft: 9, messageAllowance: 10, canSend: false, refusalMessage: "The AI is switched off for this demo." }, fallbackMessageId: FALLBACK, pageNotice: null, show: false },
    });
    expect(launcher().getAttribute("aria-label")).toBe("Open AQi");
    expect(launcher().getAttribute("title")).toBe("Open AQi, the demo guide.");
    fireEvent.click(launcher());
    expect(within(panel()).getByRole("status").textContent).toContain("The AI is switched off for this demo.");
    expect(screen.queryByLabelText("Your question")).toBeNull();
  });
});

describe("without scripts", () => {
  it("draws the panel on the page and keeps it usable: it is not hidden from assistive technology, and a rule shows it in place of the button", () => {
    const html = renderToStaticMarkup(<Workspace initialView="crm" state={state} chat={chat} />);
    const aside = html.match(/<aside[^>]*id="showroom-chat"[^>]*>/)![0];
    expect(aside).not.toMatch(/aria-hidden|inert/);
    expect(html).toMatch(/<noscript><style>[^<]*#aqi-launcher\{display:none/);
    expect(html).toMatch(/<noscript><style>[^<]*#showroom-chat\{position:static/);
    // The server always draws the rail open: the remembered fold is applied once the page is live.
    expect(html).toMatch(/<aside[^>]*id="demo-rail"[^>]*data-collapsed="false"/);
  });
});
