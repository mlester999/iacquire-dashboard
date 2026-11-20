// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermanentGrowthPartnerConversation } from "@/components/growth-partner/permanent-conversation";
import { loadOlderGrowthPartnerMessagesAction, refreshGrowthPartnerConversationAction, searchGrowthPartnerConversationAction } from "@/app/actions/ai-growth-partner-conversation";

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
        nextCursor: null,
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

  it("unlocks the composer when the save succeeds but refreshing history fails", async () => {
    const conversation = { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-11-07T00:00:00.000Z" };
    vi.mocked(refreshGrowthPartnerConversationAction)
      .mockRejectedValueOnce(new Error("The saved history is temporarily unreachable."))
      .mockResolvedValueOnce({
        ok: true,
        data: {
          conversation,
          messages: [{
            id: "saved-message",
            role: "user",
            authorUserId: null,
            authorLabel: "Workspace member",
            content: "My saved question",
            status: "complete",
            runId: null,
            workJobId: null,
            workJobRunning: false,
            errorCode: null,
            evidence: null,
            createdAt: "2026-11-07T00:01:00.000Z",
          }],
          hasMore: false,
          nextCursor: null,
        },
      });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversationId: conversation.id }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PermanentGrowthPartnerConversation initial={{ conversation, messages: [], hasMore: false }}
      initialInput="My saved question" timeZone="UTC" nowIso="2026-11-07T01:00:00.000Z" />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(refreshGrowthPartnerConversationAction).toHaveBeenCalledTimes(1));
    const refresh = screen.getByRole("button", { name: "Refresh conversation" });
    await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
    fireEvent.click(refresh);
    expect(await screen.findByText("My saved question")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("loads an older keyset page while retaining the messages already shown", async () => {
    const newest = {
      id: "20000000-0000-4000-8000-000000000002",
      role: "user" as const,
      authorUserId: null,
      authorLabel: "Workspace member",
      content: "Newest saved message",
      status: "complete" as const,
      runId: null,
      workJobId: null,
      workJobRunning: false,
      errorCode: null,
      evidence: null,
      createdAt: "2026-06-02T10:00:00.000Z",
    };
    const older = { ...newest, id: "10000000-0000-4000-8000-000000000001", content: "Older saved message", createdAt: "2026-06-01T10:00:00.000Z" };
    vi.mocked(loadOlderGrowthPartnerMessagesAction).mockResolvedValue({
      ok: true,
      data: { messages: [older], hasMore: false, nextCursor: null },
    });
    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
      messages: [newest],
      hasMore: true,
    }} timeZone="UTC" nowIso="2026-06-02T11:00:00.000Z" />);

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(await screen.findByText("Older saved message")).toBeTruthy();
    expect(screen.getByText("Newest saved message")).toBeTruthy();
    expect(loadOlderGrowthPartnerMessagesAction).toHaveBeenCalledWith({ createdAt: newest.createdAt, id: newest.id });
  });

  it("links running work and ledger evidence to their review pages", async () => {
    const message = {
      id: "10000000-0000-4000-8000-000000000001",
      role: "assistant" as const,
      authorUserId: null,
      authorLabel: "AI Growth Partner",
      content: "I started the requested work.",
      status: "complete" as const,
      runId: null,
      workJobId: "20000000-0000-4000-8000-000000000002",
      workJobRunning: true,
      errorCode: null,
      evidence: { v: 1 as const, class: "completed_action" as const, ledger: { kind: "work_job" as const, id: "job_123" } },
      createdAt: "2026-06-02T10:00:00.000Z",
    };
    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
        messages: [{ ...message, workJobRunning: false }],
        hasMore: false,
        nextCursor: null,
      },
    });
    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
      messages: [message],
      hasMore: false,
    }} timeZone="UTC" nowIso="2026-06-02T11:00:00.000Z" />);

    expect(screen.getByRole("link", { name: /View work/ }).getAttribute("href")).toBe(`/work?job=${message.workJobId}`);
    expect(screen.getByRole("link", { name: "Open ledger evidence" }).getAttribute("href")).toBe("/approvals");
    await waitFor(() => expect(refreshGrowthPartnerConversationAction).toHaveBeenCalled());
  });

  it("keeps the same client message id after a network rollback", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("10000000-0000-4000-8000-000000000001");
    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
        messages: [],
        hasMore: false,
        nextCursor: null,
      },
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network disconnected"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversationId: "shared-thread-id", assistantMessageId: "assistant-id", runId: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
      messages: [],
      hasMore: false,
    }} timeZone="UTC" nowIso="2026-06-02T11:00:00.000Z" />);

    const input = screen.getByRole("textbox", { name: "Message the AI Growth Partner" });
    fireEvent.change(input, { target: { value: "Please retry this exact message." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(input).toHaveProperty("value", "Please retry this exact message.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.clientMessageId).toBe(firstBody.clientMessageId);
  });

  it("recovers a failed SSE stream, and exposes Stop and Try again actions", async () => {
    const userMessage = {
      id: "10000000-0000-4000-8000-000000000001",
      role: "user" as const,
      authorUserId: "owner-id",
      authorLabel: "Workspace member",
      content: "Start a response",
      status: "complete" as const,
      runId: null,
      workJobId: null,
      workJobRunning: false,
      errorCode: null,
      evidence: null,
      createdAt: "2026-06-02T10:00:00.000Z",
    };
    const failedAssistant = {
      ...userMessage,
      id: "30000000-0000-4000-8000-000000000003",
      role: "assistant" as const,
      authorUserId: null,
      authorLabel: "AI Growth Partner",
      content: "Partial response",
      status: "failed" as const,
      errorCode: "interrupted",
      runId: "40000000-0000-4000-8000-000000000004",
    };
    const retryAssistant = {
      ...failedAssistant,
      id: "50000000-0000-4000-8000-000000000005",
      content: "",
      status: "streaming" as const,
      errorCode: null,
      runId: "60000000-0000-4000-8000-000000000006",
    };
    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
        messages: [userMessage, failedAssistant],
        hasMore: false,
        nextCursor: null,
      },
    });
    const frame = `data: ${JSON.stringify({
      type: "ready",
      conversationId: "shared-thread-id",
      userMessageId: userMessage.id,
      assistantMessageId: failedAssistant.id,
      runId: failedAssistant.runId,
    })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.error(new Error("SSE disconnected"));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversationId: "shared-thread-id", assistantMessageId: retryAssistant.id, runId: retryAssistant.runId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("20000000-0000-4000-8000-000000000002");
    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
      messages: [],
      hasMore: false,
    }} timeZone="UTC" nowIso="2026-06-02T11:00:00.000Z" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message the AI Growth Partner" }), { target: { value: "Start a response" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("The response stopped before it finished. You can try again.")).toBeTruthy();
    expect(screen.getByRole("log", { name: "Permanent conversation history" })).toBeTruthy();

    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-06-01T00:00:00.000Z" },
        messages: [userMessage, retryAssistant],
        hasMore: false,
        nextCursor: null,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Stop response" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][1]?.body).toContain('"regenerateMessageId":"30000000-0000-4000-8000-000000000003"');
    expect(String(fetchMock.mock.calls[2][0])).toBe(`/api/chat/runs/${retryAssistant.runId}/stop`);
  });
});
