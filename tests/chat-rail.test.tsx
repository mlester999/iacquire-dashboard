// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatRail, type ChatRailProps } from "@/components/chat/chat-rail";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";

// This project does not load @testing-library/jest-dom; these three matchers are all these tests need.
expect.extend({
  toBeInTheDocument(received: Element | null) {
    return { pass: Boolean(received?.isConnected), message: () => "expected the element to be in the document" };
  },
  toHaveAttribute(received: Element, name: string, value?: string) {
    const actual = received.getAttribute(name);
    return { pass: received.hasAttribute(name) && (value === undefined || actual === value), message: () => `expected ${name}${value === undefined ? "" : `="${value}"`}, got ${received.hasAttribute(name) ? `"${actual}"` : "no attribute"}` };
  },
  toHaveTextContent(received: Element, text: string | RegExp) {
    const content = received.textContent ?? "";
    return { pass: typeof text === "string" ? content.includes(text) : text.test(content), message: () => `expected text content ${String(text)}, got "${content}"` };
  },
});
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match vitest's own declaration
  interface Assertion<T = any> {
    toBeInTheDocument(): T;
    toHaveAttribute(name: string, value?: string): T;
    toHaveTextContent(text: string | RegExp): T;
  }
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
  usePathname: () => "/chat/lead-hunter",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("@/components/help/help-widget", () => ({ openHelp: vi.fn() }));
vi.mock("@/components/providers", () => ({ useTheme: () => ({ resolved: "light", setTheme: vi.fn() }) }));

beforeAll(() => {
  // jsdom has no matchMedia; motion's reduced-motion hook asks for it.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

/** The specialist row for an employee, found by its chat route (their names also appear in the profile and manage links). */
const specialist = (slug: string) => screen.getAllByRole("link").find((a) => a.getAttribute("href") === `/chat/${slug}`)!;

const NOW = new Date("2026-10-20T04:00:00.000Z");

function shellData(over: Partial<ShellData> = {}): ShellData {
  return {
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "Asia/Manila", role: "owner" },
    memberships: [],
    permissions: ["agents.use", "agents.configure"],
    agents: [
      { role: "operations_manager", displayName: "Operations Manager", status: "online", enabled: true },
      { role: "lead_hunter", displayName: "Lead Hunter", status: "setup_required", enabled: true },
      { role: "appointment_setter", displayName: "Appointment Setter", status: "offline", enabled: true },
      { role: "sales_assistant", displayName: "Sales Assistant", status: "provisioning", enabled: false },
    ],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode: null,
    ...over,
  };
}

function props(over: Partial<ChatRailProps> = {}): ChatRailProps {
  return {
    role: "lead_hunter",
    agentName: "Lead Hunter",
    currentStatus: "setup_required",
    conversations: [
      { id: "c1", title: "Follow up with the HOA lead", lastMessageAt: "2026-10-20T01:00:00.000Z" },
      { id: "c2", title: "Quote questions for the Lakeview roof", lastMessageAt: "2026-10-19T04:00:00.000Z" },
      { id: "c3", title: "Spring campaign ideas", lastMessageAt: "2026-08-01T04:00:00.000Z" },
    ],
    activeId: "c1",
    search: "",
    listState: "idle",
    onSearch: vi.fn(),
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    canManage: true,
    now: NOW,
    timeZone: "Asia/Manila",
    ...over,
  };
}

function renderRail(rail: Partial<ChatRailProps> = {}, shell: Partial<ShellData> = {}) {
  return render(
    <ShellProvider value={shellData(shell)}>
      <TooltipProvider>
        <ChatRail {...props(rail)} />
      </TooltipProvider>
    </ShellProvider>,
  );
}

describe("ChatRail navigation", () => {
  it("shows the brand, links home, and offers a clear way back to AI Employees", () => {
    renderRail();
    expect(screen.getByRole("link", { name: /iAcquire dashboard/i })).toHaveAttribute("href", "/overview");
    expect(screen.getByRole("link", { name: /Back to AI Employees/i })).toHaveAttribute("href", "/employees");
    expect(screen.getByText("Acquire")).toBeInTheDocument();
  });

  it("returns an agency Super Admin to the agency workforce area, not the client directory", () => {
    renderRail({}, { org: { ...shellData().org, kind: "agency", name: "iAcquire" } });
    expect(screen.getByRole("link", { name: /Back to AI Employees/i })).toHaveAttribute("href", "/admin/employees");
    expect(screen.getByRole("link", { name: /iAcquire agency dashboard/i })).toHaveAttribute("href", "/admin");
  });

  it("lists only enabled specialists, each opening that employee's chat", () => {
    renderRail();
    expect(specialist("operations-manager")).toHaveAttribute("href", "/chat/operations-manager");
    expect(specialist("lead-hunter")).toHaveAttribute("href", "/chat/lead-hunter");
    expect(specialist("appointment-setter")).toHaveAttribute("href", "/chat/appointment-setter");
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href") === "/chat/sales-assistant")).toBe(false);
  });

  it("marks the current specialist and shows each one's real readiness as text, not colour alone", () => {
    renderRail();
    const current = specialist("lead-hunter");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(specialist("operations-manager")).not.toHaveAttribute("aria-current");
    expect(within(specialist("operations-manager")).getAllByText("Online").length).toBeGreaterThan(0);
    expect(within(current).getAllByText("Setup required").length).toBeGreaterThan(0);
    expect(within(specialist("appointment-setter")).getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("prefers the status the chat page computed for the current employee over the shell snapshot", () => {
    renderRail({ currentStatus: "online" });
    expect(within(specialist("lead-hunter")).getAllByText("Online").length).toBeGreaterThan(0);
  });

  it("does not navigate when the current specialist is chosen again (it would drop the open conversation)", () => {
    const onNavigate = vi.fn();
    renderRail({ onNavigate });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    specialist("lead-hunter").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const other = new MouseEvent("click", { bubbles: true, cancelable: true });
    specialist("operations-manager").dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("offers the profile to everyone and Manage only to people who may configure", () => {
    const { unmount } = renderRail({ canManage: true });
    expect(screen.getByRole("link", { name: "Lead Hunter profile" })).toHaveAttribute("href", "/employees/lead-hunter");
    expect(screen.getByRole("link", { name: "Manage Lead Hunter" })).toHaveAttribute("href", "/employees/lead-hunter?tab=configure");
    unmount();
    renderRail({ canManage: false });
    expect(screen.getByRole("link", { name: "Lead Hunter profile" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Manage / })).toBeNull();
  });

  it("shows a demo marker only for demo workspaces", () => {
    const { unmount } = renderRail();
    expect(screen.queryByText("Demo")).toBeNull();
    unmount();
    renderRail({}, { org: { ...shellData().org, isDemo: true } });
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("closes the drawer when a link is followed and offers an explicit close control there", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderRail({ onNavigate, onClose });
    fireEvent.click(screen.getByRole("link", { name: /Back to AI Employees/i }));
    expect(onNavigate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ChatRail conversations", () => {
  it("groups by the workspace's day and shows compact relative times", () => {
    renderRail();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Older" })).toBeInTheDocument();
    expect(screen.getByText("3h")).toBeInTheDocument();
  });

  it("selects a conversation and highlights the open one", () => {
    const onSelect = vi.fn();
    renderRail({ onSelect });
    const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-conv-row"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    fireEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledWith("c2");
  });

  it("truncates long titles visually but keeps the full title available", () => {
    const title = "A very long conversation title ".repeat(8).trim();
    renderRail({ conversations: [{ id: "long", title, lastMessageAt: "2026-10-20T03:00:00.000Z" }], activeId: null });
    const row = screen.getAllByRole("button").find((b) => b.hasAttribute("data-conv-row"))!;
    expect(row.getAttribute("title")).toContain(title);
    expect(within(row).getByText(title).className).toContain("truncate");
  });

  it("moves focus between conversations with the arrow keys, Home and End", () => {
    renderRail();
    const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-conv-row"));
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("jumps from the search box to the first result with ArrowDown and clears with Escape", () => {
    const onSearch = vi.fn();
    renderRail({ search: "roof", onSearch });
    const search = screen.getByRole("searchbox", { name: /Search conversations with Lead Hunter/i });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onSearch).toHaveBeenCalledWith("");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = screen.getAllByRole("button").find((b) => b.hasAttribute("data-conv-row"));
    expect(document.activeElement).toBe(first);
  });

  it("reports typing, the new-conversation button, and a clear button when there is a query", () => {
    const onSearch = vi.fn();
    const onNew = vi.fn();
    renderRail({ onSearch, onNew, search: "hoa" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "hoa lead" } });
    expect(onSearch).toHaveBeenCalledWith("hoa lead");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearch).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("explains an empty history and an empty search differently", () => {
    const { unmount } = renderRail({ conversations: [], activeId: null });
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(screen.getByText(/Chats stay with this employee/)).toBeInTheDocument();
    unmount();
    const onSearch = vi.fn();
    renderRail({ conversations: [], activeId: null, search: "zzz", onSearch });
    expect(screen.getByText("No matching conversations")).toBeInTheDocument();
    // The search box has its own clear control; the empty state offers a second, labelled one.
    fireEvent.click(screen.getByText("Clear search"));
    expect(onSearch).toHaveBeenCalledWith("");
  });

  it("announces a search in progress and keeps the current rows visible while it runs", () => {
    renderRail({ listState: "loading", search: "hoa" });
    expect(screen.getByRole("status")).toHaveTextContent("Searching conversations");
    expect(screen.getAllByRole("button").filter((b) => b.hasAttribute("data-conv-row"))).toHaveLength(3);
  });

  it("shows a recoverable error instead of an empty list when loading fails", () => {
    const onRetry = vi.fn();
    renderRail({ listState: "error", onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load conversations");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("only offers actions the backend supports: rename and delete (no pin or archive)", async () => {
    renderRail();
    const options = screen.getByRole("button", { name: "Options for Follow up with the HOA lead" });
    expect(options).toBeInTheDocument();
    // Radix opens its menu on pointer down.
    fireEvent.pointerDown(options, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Pin|Archive/ })).toBeNull();
  });
});

describe("ChatRail collapsed (desktop)", () => {
  it("keeps every navigation action reachable by name when only icons are shown", () => {
    const onToggleCompact = vi.fn();
    renderRail({ compact: true, onToggleCompact });
    expect(screen.getByRole("link", { name: "Back to AI Employees" })).toHaveAttribute("href", "/employees");
    expect(screen.getByRole("link", { name: "Lead Hunter, Setup required" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Operations Manager, Online" })).toHaveAttribute("href", "/chat/operations-manager");
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lead Hunter profile" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage Lead Hunter" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onToggleCompact).toHaveBeenCalledTimes(1);
  });

  it("hides Manage from the collapsed rail for viewers who cannot configure", () => {
    renderRail({ compact: true, canManage: false, onToggleCompact: vi.fn() });
    expect(screen.queryByRole("link", { name: /^Manage / })).toBeNull();
  });
});
