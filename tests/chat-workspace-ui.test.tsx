// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { AGENT_BY_KEY, AGENT_ROLES } from "@/lib/agents";
import { loadConversationAction, searchConversationsAction } from "@/app/actions/chat";
import type { ShellData } from "@/server/queries/shell";

expect.extend({
  toBeInTheDocument(received: Element | null) {
    return { pass: Boolean(received?.isConnected), message: () => "expected the element to be in the document" };
  },
  toHaveAttribute(received: Element, name: string, value?: string) {
    const actual = received.getAttribute(name);
    return { pass: received.hasAttribute(name) && (value === undefined || actual === value), message: () => `expected ${name}${value === undefined ? "" : `=\"${value}\"`}, got ${received.hasAttribute(name) ? `\"${actual}\"` : "no attribute"}` };
  },
  toHaveTextContent(received: Element, text: string | RegExp) {
    const content = received.textContent ?? "";
    return { pass: typeof text === "string" ? content.includes(text) : text.test(content), message: () => `expected text content ${String(text)}, got \"${content}\"` };
  },
});
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match Vitest's declaration
  interface Assertion<T = any> {
    toBeInTheDocument(): T;
    toHaveAttribute(name: string, value?: string): T;
    toHaveTextContent(text: string | RegExp): T;
  }
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
  usePathname: () => "/chat/operations-manager",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("@/components/help/help-widget", () => ({ openHelp: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
vi.mock("@/components/providers", () => ({ useTheme: () => ({ resolved: "light", setTheme: vi.fn() }) }));
vi.mock("@/app/actions/chat", () => ({
  deleteConversationAction: vi.fn(),
  loadConversationAction: vi.fn(),
  loadOlderMessagesAction: vi.fn(),
  renameConversationAction: vi.fn(),
  searchConversationsAction: vi.fn(),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo ??= function scrollTo() {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

function shellData(): ShellData {
  return {
    user: { id: "u1", name: "Workspace Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "agency-1", name: "iAcquire", isDemo: false, kind: "agency", onboardingComplete: true, timezone: "Asia/Manila", role: "owner" },
    memberships: [],
    permissions: ["agents.use", "agents.configure"],
    agents: [{ role: "operations_manager", displayName: "Zeng", status: "online", enabled: true }],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode: null,
  };
}

type ChatProps = React.ComponentProps<typeof ChatWorkspace>;
const header = () => screen.getByLabelText("Employee chat");
const history = {
  id: "c1",
  title: "Review this week's priorities",
  messages: [{ id: "m1", role: "user" as const, content: "Keep this saved message", status: "complete" as const, run_id: null, work_job_id: null, error_code: null, created_at: "2026-10-21T03:59:00.000Z" }],
};

function renderChat(overrides: Partial<ChatProps> = {}) {
  const props: React.ComponentProps<typeof ChatWorkspace> = {
    meta: AGENT_BY_KEY.operations_manager,
    agentName: "Zeng",
    status: "online",
    statusDetail: null,
    configVersion: 4,
    lastHealthCheckAt: "2026-10-21T03:59:00.000Z",
    lastHealthOk: true,
    inventoryContract: "hermes.api_server.tool_catalog.v1",
    inventoryDigest: "a".repeat(64),
    inventoryVerifiedAt: "2026-10-21T03:59:00.000Z",
    inventoryExpiresAt: "2026-10-21T04:02:00.000Z",
    inventoryToolCount: 6,
    credentialReady: true,
    isAgencyEmployee: true,
    identityCurrent: true,
    acknowledgementCurrent: true,
    taskExecuting: false,
    canConfigure: true,
    configured: true,
    hasPendingReview: false,
    initialConversations: [],
    initialConversation: null,
    activeRunId: null,
    preferredTimeZone: "Asia/Manila",
    orgKind: "agency",
    nowIso: "2026-10-21T04:00:00.000Z",
    ...overrides,
  };
  const shell = shellData();
  shell.org = { ...shell.org, kind: props.orgKind, name: props.orgKind === "agency" ? "iAcquire" : "Brightside Roofing", id: props.orgKind === "agency" ? "agency-1" : "client-1" };
  shell.agents = [{ role: props.meta.key, displayName: props.agentName, status: props.status, enabled: true }];
  shell.permissions = props.canConfigure ? ["agents.use", "agents.configure"] : ["agents.use"];

  return render(
    <ShellProvider value={shell}>
      <TooltipProvider>
        <ChatWorkspace {...props} />
      </TooltipProvider>
    </ShellProvider>,
  );
}

describe("dedicated employee chat surface", () => {
  it("keeps reply-length choices out of runtime chat while preserving the saved ready state", () => {
    renderChat();

    expect(within(header()).getByRole("status", { name: "Ready for authorized work" })).toHaveTextContent("Ready");
    expect(screen.queryByRole("radiogroup", { name: "Reply length" })).toBeNull();
    expect(screen.queryByText(/^(Concise|Balanced|Detailed)$/)).toBeNull();
    expect(screen.getByText("Read-only chat. No records are changed and no messages are sent externally.")).toBeInTheDocument();
    expect(screen.queryByText(/Customer-facing actions always need your approval/)).toBeNull();
  });

  it("offers read-only limits in optional employee information, without a permanent snapshot pill", () => {
    renderChat();

    expect(screen.queryByText("Read-only workspace snapshot")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Employee information" });
    expect(trigger).toBeInTheDocument();
    expect(trigger.closest("[role=alert]")).toBeNull();
    fireEvent.click(trigger);

    const disclosure = screen.getByRole("dialog");
    expect(within(disclosure).getByText(/fresh, bounded snapshot/)).toBeInTheDocument();
    expect(within(disclosure).getByText(/no live refresh during a run/)).toBeInTheDocument();
    expect(within(disclosure).getByText(/cannot create or update records/)).toBeInTheDocument();
    expect(within(disclosure).getByText(/create or decide approvals/)).toBeInTheDocument();
    expect(within(disclosure).getByText(/save workspace summaries/)).toBeInTheDocument();
    expect(within(disclosure).getByText(/send messages externally/)).toBeInTheDocument();
  });

  it.each(AGENT_ROLES.flatMap((meta) => ["agency", "client"].map((orgKind) => ({ meta, orgKind }))))("uses the same clean header for $meta.shortName in $orgKind workspaces", ({ meta, orgKind }) => {
    renderChat({ meta, agentName: meta.key === "operations_manager" && orgKind === "agency" ? "Zeng" : meta.shortName, orgKind, isAgencyEmployee: orgKind === "agency", initialConversation: history, initialConversations: [{ id: history.id, title: history.title, lastMessageAt: history.messages[0].created_at }] });
    const chatHeader = within(header());
    expect(chatHeader.getByRole("heading", { level: 1 })).toHaveTextContent(meta.key === "operations_manager" && orgKind === "agency" ? "Zeng" : meta.shortName);
    expect(chatHeader.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open chat navigation", "New chat", "Employee information"]);
    expect(header().textContent).not.toMatch(/workspace|snapshot|reverified|Hermes|attestation|configuration|conversation/i);
    expect(chatHeader.queryByText(history.title)).toBeNull();
    expect(screen.getByRole("button", { name: new RegExp(`^${history.title}`) })).toBeInTheDocument();
    expect(screen.getByText("Keep this saved message")).toBeInTheDocument();
    if (orgKind === "client") expect(header().textContent).not.toMatch(/Zeng|iAcquire/);
    if (meta.key !== "operations_manager") expect(chatHeader.getAllByText(meta.shortName)).toHaveLength(1);
  });

  it("keeps stale verification explanations in employee information", () => {
    renderChat({ inventoryExpiresAt: "2026-10-21T03:59:59.000Z" });
    expect(header().textContent).toContain("Ready");
    expect(screen.queryByText(/Tools are reverified|server rechecks runtime tools|short-lived attestation/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Employee information" }));
    expect(within(screen.getByRole("dialog")).getByText(/server refreshes the short-lived attestation/)).toBeInTheDocument();
  });

  it("shows only the client's employee context and authorized controls in details", () => {
    renderChat({ orgKind: "client", isAgencyEmployee: false, agentName: "Bailey", canConfigure: false, identityCurrent: null, acknowledgementCurrent: null });
    expect(within(header()).getByRole("heading", { name: "Bailey" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Employee information" }));
    const info = screen.getByRole("dialog", { name: "Employee information" });
    expect(info.textContent).not.toMatch(/Zeng|iAcquire|internal records|snapshot|Super Admin/);
    expect(within(info).getByRole("link", { name: "View employee" })).toHaveAttribute("href", "/employees/operations-manager");
    expect(within(info).queryByRole("link", { name: "Manage employee" })).toBeNull();
  });

  it("keeps pending configuration review in employee details when an applied version is usable", () => {
    renderChat({ hasPendingReview: true });
    expect(header().textContent).not.toMatch(/Configuration review/);
    fireEvent.click(screen.getByRole("button", { name: "Employee information" }));
    expect(screen.getByText(/Configuration review pending. The requested changes are not active/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage employee" })).toHaveAttribute("href", "/employees/operations-manager?tab=configure");
  });

  it.each([
    { overrides: { lastHealthOk: false, statusDetail: "Permission denied: reconnect this employee." }, label: "Needs attention", detail: "Permission denied: reconnect this employee." },
    { overrides: { acknowledgementCurrent: false }, label: "Awaiting approval", detail: "Record the current administrative acknowledgement" },
    { overrides: { credentialReady: false }, label: "Needs attention", detail: "The saved Hermes credential is unavailable" },
    { overrides: { inventoryDigest: null }, label: "Verification required", detail: "Record the approved tool inventory" },
    { overrides: { status: "disabled" as const }, label: "Paused", detail: "This employee is paused" },
    { overrides: { configVersion: null, configured: false, hasPendingReview: true }, label: "Awaiting review", detail: "A configuration change is under review" },
  ])("keeps $label and the actionable reason visible", ({ overrides, label, detail }) => {
    renderChat(overrides);
    expect(within(header()).getByRole("status")).toHaveTextContent(label);
    expect(header().textContent).not.toContain("Ready");
    expect(screen.getAllByText(detail).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: /Message Zeng/ })).toBeNull();
  });

  it("shows recorded execution rather than idle readiness", () => {
    renderChat({ taskExecuting: true });
    expect(within(header()).getByRole("status", { name: "Working / executing" })).toHaveTextContent("Working");
  });

  it("retains the unavailable reason beside saved history", () => {
    renderChat({ lastHealthOk: false, statusDetail: "Connection revoked. Reconnect to continue.", initialConversation: history });
    expect(screen.getByText("Connection revoked. Reconnect to continue.")).toBeInTheDocument();
    expect(screen.getByText("Keep this saved message")).toBeInTheDocument();
  });

  it("opens information with a keyboard, returns focus on Escape, and keeps long names intact", async () => {
    const user = userEvent.setup();
    const name = "Bailey " + "Very long employee name ".repeat(8);
    renderChat({ agentName: name });
    const heading = within(header()).getByRole("heading", { level: 1 });
    expect(heading).toHaveAttribute("title", name.trim());
    expect(heading.classList.contains("truncate")).toBe(true);
    const trigger = screen.getByRole("button", { name: "Employee information" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Employee information" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps mobile navigation, conversation selection and new chat working", async () => {
    vi.mocked(loadConversationAction).mockResolvedValue({ ok: true, data: { messages: history.messages, hasMore: false } } as Awaited<ReturnType<typeof loadConversationAction>>);
    renderChat({ initialConversations: [{ id: history.id, title: history.title, lastMessageAt: history.messages[0].created_at }] });
    fireEvent.click(screen.getByRole("button", { name: "Open chat navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Chat navigation" });
    fireEvent.click(within(drawer).getByRole("button", { name: new RegExp(`^${history.title}`) }));
    await waitFor(() => expect(screen.getByText("Keep this saved message")).toBeInTheDocument());
    expect(loadConversationAction).toHaveBeenCalledWith(history.id);
    expect(within(header()).queryByText(history.title)).toBeNull();
    // The drawer closes after a conversation is chosen; until it unmounts, its focus lock hides the header buttons from the accessibility tree.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat navigation" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("Keep this saved message")).toBeNull();
    expect(screen.getByRole("textbox", { name: /Message Zeng/ })).toBeInTheDocument();
  });

  // Uses the same optional Playwright installation as scripts/chat-navigation-qa.mjs.
  // This renders the actual component markup with the app's CSS; it needs no Next server or database.
  it.skipIf(!process.env.PLAYWRIGHT_MODULE)("fits mobile and desktop headers, long names and blocked states in a browser", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { default: postcss } = await import("postcss");
    const { default: tailwind } = await import("@tailwindcss/postcss");
    const { chromium } = await import(/* @vite-ignore */ pathToFileURL(process.env.PLAYWRIGHT_MODULE!).href);
    const cssPath = resolve("src/app/globals.css");
    const candidates = new Set<string>();
    for (const lastHealthOk of [true, false]) {
      const view = renderChat({ lastHealthOk });
      view.container.querySelectorAll("[class]").forEach((element) => element.classList.forEach((candidate) => candidates.add(candidate)));
      cleanup();
    }
    const source = (await readFile(cssPath, "utf8")).replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
    const css = await postcss([tailwind()]).process(`${source}\n@source inline(${JSON.stringify([...candidates].join(" "))});`, { from: cssPath });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const name of ["Zeng", "Bailey " + "Long employee name ".repeat(12)]) {
        for (const blocked of [false, true]) {
          const view = renderChat({ agentName: name, lastHealthOk: !blocked, statusDetail: blocked ? "Permission denied. Reconnect to continue." : null });
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 844 });
            await page.setContent(`<html><head><style>${css.css}</style></head><body>${view.container.innerHTML}</body></html>`);
            const measurements = await page.locator("header").evaluate((element: HTMLElement) => {
              const heading = element.querySelector("h1")!;
              const status = element.querySelector('[role="status"]')!;
              const buttons = Array.from(element.querySelectorAll("button")).filter((button) => getComputedStyle(button).display !== "none");
              return {
                headerHeight: element.getBoundingClientRect().height,
                overflow: document.documentElement.scrollWidth > innerWidth,
                headingOverflow: getComputedStyle(heading).textOverflow,
                status: status.textContent,
                clippedControls: buttons.some((button) => { const rect = button.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.width < 40 || rect.height < 40; }),
              };
            });
            expect(measurements.overflow, `${width}px, ${name}, blocked=${blocked}`).toBe(false);
            expect(measurements.clippedControls).toBe(false);
            expect(measurements.headerHeight).toBeLessThanOrEqual(80);
            expect(measurements.headingOverflow).toBe("ellipsis");
            expect(measurements.status).toBe(blocked ? "Needs attention" : "Ready");
          }
          cleanup();
        }
      }
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("keeps approval review and execution failures visible during a streamed response", async () => {
    const events = [
      { type: "ready", conversationId: "c2", userMessageId: "u2", assistantMessageId: "a2", runId: "r2" },
      { type: "approval", approvalId: "approval-1", title: "Approve the requested action" },
      { type: "error", code: "run_failed", message: "The run failed.", retryable: false },
    ];
    vi.mocked(searchConversationsAction).mockResolvedValue({ ok: true, data: [] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })));
    renderChat();
    fireEvent.change(screen.getByRole("textbox", { name: /Message Zeng/ }), { target: { value: "Please review this request" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Approve the requested action", expect.objectContaining({ description: "Waiting for approval in the Approval Center.", action: expect.objectContaining({ label: "Review" }) })));
    await waitFor(() => expect(screen.getByText(/Your AI employee couldn't finish this request/)).toBeInTheDocument());
  });

  it("labels server preflight as verification before the employee run starts", async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pendingResponse));
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: /Summarise what needs my attention today/i }));

    expect(screen.getByText("Verifying access before the run starts…")).toBeInTheDocument();
    expect(screen.queryByText(/Zeng is reviewing your workspace snapshot/)).toBeNull();

    resolveFetch(new Response(JSON.stringify({ error: "Permission denied for this workspace." }), { status: 403, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(screen.queryByText("Verifying access before the run starts…")).toBeNull());
    expect(toast.error).toHaveBeenCalledWith("Permission denied for this workspace.");
  });
});
