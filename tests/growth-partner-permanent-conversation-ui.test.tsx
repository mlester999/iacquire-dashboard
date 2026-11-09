// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermanentGrowthPartnerConversation } from "@/components/growth-partner/permanent-conversation";
import { refreshGrowthPartnerConversationAction, searchGrowthPartnerConversationAction } from "@/app/actions/ai-growth-partner-conversation";

vi.mock("@/app/actions/ai-growth-partner-conversation", () => ({
  loadOlderGrowthPartnerMessagesAction: vi.fn(),
  refreshGrowthPartnerConversationAction: vi.fn(),
  searchGrowthPartnerConversationAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("permanent Growth Partner conversation UI", () => {
  it("offers no create-conversation control and always sends into the shared thread", async () => {
    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: {
          id: "shared-thread-id",
          title: "AI Growth Partner",
          lastMessageAt: null,
          createdAt: "2026-11-07T00:00:00.000Z",
        },
        messages: [],
        hasMore: false,
      },
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("10000000-0000-4000-8000-000000000001");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversationId: "shared-thread-id", runId: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-11-07T00:00:00.000Z" },
      messages: [],
      hasMore: false,
    }} initialInput="Review the latest qualified leads." timeZone="America/New_York" nowIso="2026-11-07T01:00:00.000Z" />);

    expect(screen.getByRole("heading", { level: 1, name: "AI Growth Partner" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new chat|new conversation|create conversation/i })).toBeNull();
    expect(screen.queryByText(/new chat|new conversation|create conversation/i)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message the AI Growth Partner" })).toHaveProperty("value", "Review the latest qualified leads.");

    fireEvent.change(screen.getByRole("textbox", { name: "Message the AI Growth Partner" }), { target: { value: "Keep using the shared thread." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      role: "growth_partner",
      conversationId: "shared-thread-id",
      content: "Keep using the shared thread.",
    });
    expect(refreshGrowthPartnerConversationAction).toHaveBeenCalledOnce();
  });

  it("explains setup status without exposing runtime terminology", () => {
    render(<PermanentGrowthPartnerConversation initial={null} timeZone="America/New_York" nowIso="2026-11-07T01:00:00.000Z" />);

    expect(screen.getByRole("heading", { level: 1, name: "AI Growth Partner" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your AI Growth Partner is still being set up" })).toBeTruthy();
    expect(screen.getByText("Your shared conversation will be ready when setup is complete. Previous role profile histories remain saved.")).toBeTruthy();
    expect(screen.queryByText(/runtime|thread is not connected/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Review setup" }).getAttribute("href")).toBe("/growth-partner");
  });

  it("labels a member's saved previous-profile history within the permanent conversation search", async () => {
    vi.mocked(searchGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: [{
        id: "previous-message-id",
        role: "assistant",
        authorLabel: null,
        source: "previous_profile",
        profileLabel: "Previous profile · AI Sales Assistant",
        excerpt: "The prior profile discussed a roofing campaign.",
        createdAt: "2025-04-02T10:00:00.000Z",
      }],
    });

    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-11-07T00:00:00.000Z" },
      messages: [],
      hasMore: false,
    }} timeZone="America/New_York" nowIso="2026-11-07T01:00:00.000Z" />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search permanent conversation" }), { target: { value: "roofing campaign" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Previous profile · AI Sales Assistant")).toBeTruthy();
    expect(screen.getByText("Previous profile history")).toBeTruthy();
    expect(screen.getByText(/Only you can see that earlier history/)).toBeTruthy();
  });
});
