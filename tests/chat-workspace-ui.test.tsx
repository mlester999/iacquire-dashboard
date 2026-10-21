// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { AGENT_BY_KEY } from "@/lib/agents";
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

function renderChat() {
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
  };

  return render(
    <ShellProvider value={shellData()}>
      <TooltipProvider>
        <ChatWorkspace {...props} />
      </TooltipProvider>
    </ShellProvider>,
  );
}

describe("dedicated employee chat surface", () => {
  it("keeps reply-length choices out of runtime chat while preserving the saved ready state", () => {
    renderChat();

    expect(screen.getByText("Ready for authorized work")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Reply length" })).toBeNull();
    expect(screen.queryByText(/^(Concise|Balanced|Detailed)$/)).toBeNull();
    expect(screen.getByText("Read-only chat. No records are changed and no messages are sent externally.")).toBeInTheDocument();
    expect(screen.queryByText(/Customer-facing actions always need your approval/)).toBeNull();
  });

  it("shows a neutral snapshot disclosure with the exact read-only limits", () => {
    renderChat();

    const trigger = screen.getByRole("button", { name: "Read-only workspace snapshot" });
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

  it("labels server preflight as verification before the employee run starts", async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pendingResponse));
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: /Summarise what needs my attention today/i }));

    expect(screen.getByText("Verifying access before the run starts…")).toBeInTheDocument();
    expect(screen.queryByText(/Zeng is reviewing your workspace snapshot/)).toBeNull();

    resolveFetch(new Response(JSON.stringify({ error: "blocked in test" }), { status: 403, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(screen.queryByText("Verifying access before the run starts…")).toBeNull());
  });
});
