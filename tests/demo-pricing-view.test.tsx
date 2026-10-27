// @vitest-environment jsdom
// The Plans & pricing view, clicked through: both plans (their words, their prices, the buttons that sit under each price and fill the card, what each includes), the side-by-side
// table, and the pricing questions. The server is replaced by a recorder: nothing here may send a message or record a request by itself. The layout (equal cards, no empty stretch,
// aligned rows) is for the lead's browser pass at 375, 820 and 1440 px; here are the words, roles, states and calls.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
import { AGENT_BY_KEY } from "@/lib/agents";
import { CORE_INCLUDES, STUDIO_INCLUDES } from "@/lib/demo/showroom/content";
import { EMPLOYEE_ORDER } from "@/lib/demo/showroom/employees";
import { scenarioFor } from "@/lib/demo/showroom/industry";

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
  plan: { included: null, monthlyRequestAllowance: 4 },
  ctaNotice: null,
  initialConfirm: null,
};
const chat: WorkspaceProps["chat"] = {
  initial: { transcript: [], messagesLeft: 9, messageAllowance: 10, canSend: true, refusalMessage: null },
  fallbackMessageId: "00000000-0000-4000-8000-000000000000",
  pageNotice: null,
  show: true,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  window.localStorage.clear();
  window.history.replaceState(null, "", "/demo/room?view=pricing");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pricing(over: Partial<WorkspaceProps["state"]> = {}) {
  return render(<Workspace initialView="pricing" state={{ ...state, ...over }} chat={chat} />);
}
const core = () => document.querySelector<HTMLElement>('section[aria-labelledby="core-plan"]')!;
const plus = () => document.querySelector<HTMLElement>('section[aria-labelledby="plus-plan"]')!;
const money = (n: number) => `US$${n.toLocaleString("en-US")}`;

describe("the two plans", () => {
  it("are headed and priced as the offer states them, with the monthly plan optional", () => {
    pricing();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("One implementation. One optional plan.");
    expect(within(core()).getByRole("heading", { level: 2, name: "Core implementation" })).toBeTruthy();
    expect(within(plus()).getByRole("heading", { level: 2, name: "Managed Maintenance" })).toBeTruthy();
    expect(core().textContent).toContain(money(SETUP_FEE_USD));
    expect(core().textContent).toContain("One-time implementation");
    expect(core().textContent).toContain("No mandatory subscription");
    expect(core().textContent).toContain("Paid once");
    expect(plus().textContent).toContain(money(MAINTENANCE_MONTHLY_USD));
    expect(plus().textContent).toContain("per month, only if you choose it");
    expect(plus().textContent).toContain("Optional add-on");
  });

  it("put every button under the price, as wide as the card and centred, before the list of what is included", () => {
    pricing();
    const buttons = [
      within(core()).getByRole("link", { name: /Book a free consultation/ }),
      within(core()).getByRole("link", { name: /I'm ready to get started/ }),
      within(plus()).getByRole("link", { name: /Ask about Managed Maintenance/ }),
    ];
    for (const b of buttons) {
      expect(b.classList.contains("w-full"), b.textContent!).toBe(true);
      expect(b.classList.contains("justify-center"), b.textContent!).toBe(true);
    }
    for (const [card, list] of [[core(), "Included in the core implementation"], [plus(), "What Managed Maintenance adds"]] as const) {
      const first = within(card).getAllByRole("link")[0];
      const included = within(card).getByRole("list", { name: list });
      expect(first.compareDocumentPosition(included) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("list what each includes, from the one place the words live, with Automation Studio only under Managed Maintenance", () => {
    pricing();
    const included = within(core()).getByRole("list", { name: "Included in the core implementation" });
    expect(within(included).getAllByRole("listitem").map((li) => li.textContent)).toEqual(CORE_INCLUDES);
    expect(core().textContent).not.toMatch(/Automation Studio/);
    const studio = within(plus()).getByRole("list", { name: "Automation Studio, part of Managed Maintenance" });
    expect(within(studio).getAllByRole("listitem").map((li) => li.textContent)).toEqual(STUDIO_INCLUDES);
    // The published plan's change allowance is stated when the catalog gave one, and never invented when it did not.
    expect(plus().textContent).toContain("The published plan covers up to 4 change requests a month.");
    cleanup();
    pricing({ plan: { included: null, monthlyRequestAllowance: null } });
    expect(plus().textContent).not.toMatch(/change requests/);
    expect(plus().textContent).toContain("Add it any time, only if you choose it.");
  });

  it("show the six AI Employees by role name in the core plan, and no name a company chose", () => {
    pricing();
    const names = EMPLOYEE_ORDER.map((k) => AGENT_BY_KEY[k].shortName);
    expect(names).toHaveLength(6);
    for (const n of names) expect(within(core()).getByText(n), n).toBeTruthy();
    expect(core().textContent).not.toMatch(/Zeng/);
  });

  it("keep the two requests to what they were: a confirmation first, nothing recorded or sent by pressing the button", () => {
    pricing();
    fireEvent.click(within(core()).getByRole("link", { name: /Book a free consultation/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("say so, centred in the card, once a request has been made", () => {
    pricing({ consultationRequested: true, purchaseStarted: true });
    expect(within(core()).queryByRole("link", { name: /Book a free consultation/ })).toBeNull();
    const statuses = within(core()).getAllByRole("status");
    expect(statuses.map((s) => s.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Request received"), expect.stringContaining("The team knows you are ready")]));
    for (const s of statuses) expect(s.classList.contains("justify-center")).toBe(true);
  });

  it("send a visitor to the comparison from the Managed Maintenance card", () => {
    pricing();
    const link = within(plus()).getByRole("link", { name: /Compare the two plans/ });
    expect(link.getAttribute("href")).toBe("#compare-plans");
    const target = document.getElementById("compare-plans")!;
    expect(within(target).getByRole("table")).toBeTruthy();
  });
});

describe("the side-by-side table", () => {
  it("names both options with their prices in its header, groups the rows, and says every cell in words", () => {
    pricing();
    const table = screen.getByRole("table", { name: "Core implementation compared with core plus Managed Maintenance" });
    const headers = within(table.querySelector("thead")!).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["What you get", `Core${money(SETUP_FEE_USD)}, once`, `Core + Maintenanceplus ${money(MAINTENANCE_MONTHLY_USD)} a month`]);
    expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(10);
    expect(table.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(2);
    expect(within(table).getByText("In every implementation")).toBeTruthy();
    expect(within(table).getByText("Added by Managed Maintenance")).toBeTruthy();
    // Ten rows, two columns: what the core includes and what only the monthly plan adds are said, not left to a tick mark.
    expect(within(table).getAllByText(/^Included: /)).toHaveLength(16);
    expect(within(table).getAllByText(/^Not included: /)).toHaveLength(4);
    for (const row of ["Automation Studio", "Managed media storage for social posts"]) expect(within(table).getByText(`Not included: ${row}`), row).toBeTruthy();
  });
});

describe("the pricing questions", () => {
  const details = () => [...document.querySelectorAll<HTMLDetailsElement>("details.sx-faq")];

  it("are five native questions, closed until opened, each opening on its own and keeping its answer in the page", () => {
    pricing();
    expect(details().map((d) => d.querySelector("summary")!.textContent)).toEqual([
      "Do I have to pay a monthly fee to use the system?",
      "What is Automation Studio, and do I need it?",
      "What do AI usage and messaging cost?",
      "What happens after I ask for a consultation?",
      "How long does setup take?",
    ]);
    expect(details().every((d) => !d.open)).toBe(true);
    const first = details()[0];
    fireEvent.click(first.querySelector("summary")!);
    first.open = true; // set directly: whether jsdom toggles a <details> on a click of its summary depends on its version
    expect(first.textContent).toContain("No. The implementation");
    expect(first.textContent).toContain(`$${SETUP_FEE_USD.toLocaleString("en-US")}`);
    expect(details().slice(1).every((d) => !d.open)).toBe(true);
  });

  it("offer the three pricing questions to AQi: pressing one opens AQi with the question in the box and sends nothing", () => {
    pricing();
    expect(screen.getByRole("button", { name: /^Open AQi/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "What does Managed Maintenance add?" }));
    expect(screen.getByRole("button", { name: /^Open AQi/ }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("What does Managed Maintenance add?");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("say they are questions to ask the team, not AQi, when AQi is off", () => {
    pricing({ aiEnabled: false });
    expect(screen.getByText("Questions to ask the team:")).toBeTruthy();
    expect(screen.queryByText("Ask AQi:")).toBeNull();
  });
});

describe("the closing panel", () => {
  it("has two buttons that fill their panels, and leaves no empty gap under them until a request is made", () => {
    pricing();
    const panel = document.getElementById("actions")!;
    for (const name of [/Book a free consultation/, /I'm ready to get started/]) {
      const b = within(panel).getByRole("link", { name });
      expect(b.classList.contains("w-full"), String(name)).toBe(true);
      expect(b.classList.contains("justify-center"), String(name)).toBe(true);
    }
    // The live region for the result stays in the page (so it is announced) and, being empty, takes back the gap that would sit under the panels.
    const live = [...panel.querySelectorAll<HTMLElement>('[aria-live="polite"]')].find((el) => el.classList.contains("empty:-mt-5"))!;
    expect(live).toBeTruthy();
    expect(live.childNodes.length).toBe(0);
  });
});
