// @vitest-environment jsdom
// The demo room on a phone, held to what a person needs there (the pixel measurements, at every width, are the browser run in scripts/demo-responsive-qa.mjs; here is the structure
// that makes them true and the behaviour no screenshot shows): the six Growth Partner capabilities are one set of real buttons that can never be placed on top of one another below the wide layout;
// the section navigation is slim and keeps every section; nothing floats over the page below `lg` (the consultation action and AQi share one bottom bar that keeps clear of the home
// indicator); and AQi opens as a modal sheet that the page behind cannot be reached through, that closes from the keyboard and the backdrop, and that gives the page back.
import * as React from "react";
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
import { DEMO_CAPABILITY_AREAS, VIEWS } from "@/lib/demo/showroom/content";
import { scenarioFor } from "@/lib/demo/showroom/industry";

const FALLBACK = "00000000-0000-4000-8000-000000000000";
const state: WorkspaceProps["state"] = {
  firstName: "Avery",
  business: "Harborview Realty Group",
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

function screenIs(phone: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({ matches: phone && query.includes("639"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  screenIs(false);
  window.localStorage.clear();
  window.history.replaceState(null, "", "/demo/room");
});
afterEach(() => {
  cleanup();
  document.documentElement.style.overflow = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const room = (over: Partial<WorkspaceProps> = {}) => render(<Workspace initialView="overview" state={state} chat={chat} {...over} />);
const hub = () => document.querySelector("[data-business-hub]") as HTMLElement;
const dock = () => document.querySelector("[data-dock-bar]") as HTMLElement;
const launcher = () => screen.getByRole("button", { name: /^Open AQi/ });
const panel = () => document.getElementById("showroom-chat")!;
const question = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;

describe("the six Growth Partner capabilities on the overview", () => {
  it("are six real capability buttons beside the one partner identity and business's own name", () => {
    room();
    expect(document.querySelectorAll("[data-business-hub]")).toHaveLength(1);
    const buttons = within(hub()).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(DEMO_CAPABILITY_AREAS.map((area) => `Open ${area.title}`));
    for (const [i, area] of DEMO_CAPABILITY_AREAS.entries()) {
      expect(buttons[i].querySelector("[data-capability-name]")!.textContent).toBe(area.title);
    }
    const centre = hub().querySelector("[data-hub-centre]") as HTMLElement;
    expect(centre.textContent).toContain("AI Growth Partner");
    expect(centre.textContent).toContain("Harborview Realty Group");
    expect(screen.getByRole("group", { name: "Your business and the six capabilities of one AI Growth Partner" })).toBe(hub());
  });

  it("are laid out as cards in a grid below the wide layout: nothing is placed by percentage until the container is wide enough, so nothing can collide", () => {
    room();
    // The picture (positions on an ellipse) belongs to the wide layout alone: every absolute position and every line of the drawing is behind the @2xl container query.
    expect(hub().className).toMatch(/\bgrid\b/);
    expect(hub().className).toMatch(/grid-cols-2/);
    expect(hub().className).toMatch(/@2xl:block/);
    for (const b of within(hub()).getAllByRole("button")) {
      expect(b.className.split(/\s+/)).not.toContain("absolute");
      expect(b.className).toMatch(/@2xl:absolute/);
      expect(b.style.getPropertyValue("--hub-x")).toMatch(/^\d+(\.\d+)?%$/);
      expect(b.style.getPropertyValue("--hub-y")).toMatch(/^\d+(\.\d+)?%$/);
    }
    const svg = hub().querySelector("svg")!;
    expect(svg.getAttribute("class")).toMatch(/\bhidden\b/);
    expect(svg.getAttribute("class")).toMatch(/@2xl:block/);
    const centre = hub().querySelector("[data-hub-centre]") as HTMLElement;
    expect(centre.className.split(/\s+/)).not.toContain("absolute");
    expect(centre.className).toMatch(/col-span-full/);
  });

  it("let a long business name wrap instead of being cut, and keep every capability name wrappable", () => {
    const long = "The Very Long Named Harborview Realty & Property Management Group of the Pacific Northwest";
    room({ state: { ...state, business: long } });
    const centre = hub().querySelector("[data-hub-centre]") as HTMLElement;
    expect(centre.textContent).toContain(long);
    expect(centre.innerHTML).toMatch(/break-words/);
    for (const name of hub().querySelectorAll("[data-capability-name]")) expect(name.className).toMatch(/break-words/);
  });

  it("opens the shared Growth Partner overview when a capability is pressed", () => {
    room();
    fireEvent.click(within(hub()).getByRole("button", { name: `Open ${DEMO_CAPABILITY_AREAS[0].title}` }));
    expect(window.location.search).toBe("?view=workforce");
  });
});

describe("the section navigation on a phone", () => {
  it("keeps every section one tap away, in a slim row that stays with the page, while the mark and colour choice scroll away", () => {
    const { container } = room();
    const navs = screen.getAllByRole("navigation", { name: "Sections" });
    const mobile = navs.find((n) => !n.closest("#demo-rail"))!;
    const links = within(mobile).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(VIEWS.map((v) => (v.id === "overview" ? "/demo/room" : `/demo/room?view=${v.id}`)));
    expect(links).toHaveLength(VIEWS.length);
    expect(mobile.className).toMatch(/\bsticky\b/);
    expect(mobile.className).toMatch(/lg:hidden/);
    // The row with the logo is not sticky: only one slim bar stays at the top.
    const banner = container.querySelector("header")!;
    expect(banner.className).not.toMatch(/\bsticky\b/);
    expect(banner.className).toMatch(/lg:hidden/);
    // The three-button colour switch where it fits, one cycling button where it would not.
    expect(within(banner).getByRole("group", { name: "Colour theme" })).toBeTruthy();
    expect(within(banner).getByRole("button", { name: /Colour theme: .* Press to change it/ })).toBeTruthy();
  });

  it("marks the section the visitor is on", () => {
    room({ initialView: "pricing" });
    const mobile = screen.getAllByRole("navigation", { name: "Sections" }).find((n) => !n.closest("#demo-rail"))!;
    const current = within(mobile).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/demo/room?view=pricing"]);
  });
});

describe("the bottom bar", () => {
  it("holds the consultation action and AQi's one button, so nothing floats over what is being read, and clears the home indicator", () => {
    room();
    expect(dock()).toBeTruthy();
    expect(document.querySelectorAll("#aqi-launcher")).toHaveLength(1);
    expect(within(dock()).getByRole("button", { name: /^Open AQi, 9 left$/ })).toBe(launcher());
    expect(within(dock()).getByRole("link", { name: /Request a consultation/ })).toBeTruthy();
    expect(dock().className).toMatch(/safe-area-inset-bottom/);
    expect(dock().className).toMatch(/lg:bottom-4 lg:right-4/);
    // The page keeps room under its last line for the bar.
    expect(document.querySelector("main")!.parentElement!.className).toMatch(/pb-\[calc\(5\.75rem\+env\(safe-area-inset-bottom\)\)\]/);
  });

  it("is compact: the AQi button is an icon with a count on a phone and says its name from the small tablet size up", () => {
    room();
    const button = launcher();
    expect(button.querySelector("span.hidden.sm\\:inline")!.textContent).toBe("AQi");
    expect(button.getAttribute("aria-label")).toBe("Open AQi, 9 left");
    expect(button.querySelector("[aria-hidden]")).toBeTruthy();
  });

  it("calls the consultation action 'Book a free consultation' only when there is a scheduling page to offer, and 'Request a consultation' otherwise", () => {
    room({ state: { ...state, consultationUrl: "https://calendar.example.com/intro" } });
    expect(within(dock()).getByRole("link", { name: /Book a free consultation/ })).toBeTruthy();
    expect(within(dock()).queryByRole("link", { name: /Request a consultation/ })).toBeNull();
    cleanup();
    room();
    expect(within(dock()).getByRole("link", { name: /Request a consultation/ })).toBeTruthy();
    expect(within(dock()).queryByRole("link", { name: /Book a free consultation/ })).toBeNull();
  });

  it("says the request was received once it was, and then offers the scheduling page only when there is one (a request is not a booking)", () => {
    room({ state: { ...state, consultationRequested: true } });
    expect(within(dock()).getByRole("status").textContent).toContain("Request received");
    expect(within(dock()).queryByRole("link", { name: /meeting time/ })).toBeNull();
    cleanup();
    room({ state: { ...state, consultationRequested: true, consultationUrl: "https://calendar.example.com/intro" } });
    const link = within(dock()).getByRole("link", { name: /Choose a meeting time/ });
    expect(link.getAttribute("href")).toBe("https://calendar.example.com/intro");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("AQi's sheet on a phone", () => {
  it("is a modal dialog over a page nobody can reach through, that stops the page scrolling, closes from the keyboard and gives everything back", async () => {
    screenIs(true);
    const { container } = room();
    expect(panel().getAttribute("role")).toBe("complementary");
    fireEvent.click(launcher());
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "AQi demo guide" })).toBe(panel());
    const layout = container.querySelector(".showroom-layout") as HTMLElement;
    expect(layout.hasAttribute("inert")).toBe(true);
    expect(dock().hasAttribute("inert")).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
    await waitFor(() => expect(document.activeElement).toBe(question()));
    fireEvent.change(question(), { target: { value: "Half a question" } });

    fireEvent.keyDown(question(), { key: "Escape" });
    expect(panel().getAttribute("role")).toBe("complementary");
    expect(layout.hasAttribute("inert")).toBe(false);
    expect(dock().hasAttribute("inert")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(launcher()));
    // Closing it lost nothing.
    fireEvent.click(launcher());
    expect(question().value).toBe("Half a question");
  });

  it("closes when the dimmed page behind it is pressed", () => {
    screenIs(true);
    room();
    expect(document.querySelector("[data-overlay-backdrop]")).toBeNull();
    fireEvent.click(launcher());
    fireEvent.click(document.querySelector("[data-overlay-backdrop]")!);
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("keeps the question box at 16px on a phone and has no capability or employee selector", () => {
    room();
    expect(question().className).toMatch(/text-\[16px\]/);
    expect(document.querySelector('select[name="employeeRole"]')).toBeNull();
    expect(document.querySelector('select[name="capability"]')).toBeNull();
  });

  it("is a corner panel, not a modal, on a larger screen, and leaves the page usable", () => {
    const { container } = room();
    fireEvent.click(launcher());
    expect(panel().getAttribute("role")).toBe("complementary");
    expect(panel().hasAttribute("aria-modal")).toBe(false);
    expect((container.querySelector(".showroom-layout") as HTMLElement).hasAttribute("inert")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.querySelector("[data-overlay-backdrop]")).toBeNull();
    // On a tablet the panel opens above the bar, so it never covers the consultation action.
    expect(panel().className).toMatch(/sm:bottom-\[calc\(4\.75rem\+env\(safe-area-inset-bottom\)\)\]/);
    expect(panel().className).toMatch(/lg:bottom-5/);
  });
});
