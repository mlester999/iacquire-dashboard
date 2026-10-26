// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationCenter } from "@/components/notifications/notification-center";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  fetchNotificationsAction: vi.fn(),
  markNotificationsReadAction: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("@/app/actions/shell", () => ({
  fetchNotificationsAction: mocks.fetchNotificationsAction,
  markNotificationsReadAction: mocks.markNotificationsReadAction,
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

const NOW = Date.now();
const CREATED = new Date(NOW - 5 * 60_000).toISOString();

function item(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "agent_status",
    severity: "warning",
    title: "Sales Assistant update needs review",
    body: "Part of the new instructions looked like it could change safety rules.",
    link: "/employees/sales-assistant",
    read_at: null,
    created_at: CREATED,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.fetchNotificationsAction.mockReset();
  mocks.markNotificationsReadAction.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("notification centre", () => {
  it("loads the signed-in person's latest saved notifications with compact relative time", async () => {
    mocks.fetchNotificationsAction.mockResolvedValue({
      ok: true,
      unread: 1,
      hasMore: false,
      nextBefore: null,
      nextBeforeId: null,
      items: [item()],
    });
    render(<NotificationCenter initialUnread={1} initialNow={NOW} timeZone="UTC" viewAllHref="/notifications" settingsHref="/settings/notifications" />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));

    expect(await screen.findByText("Sales Assistant update needs review")).toBeTruthy();
    expect(mocks.fetchNotificationsAction).toHaveBeenCalledWith({ limit: 12 });
    const relative = screen.getByText("5m ago");
    expect(relative).toBeTruthy();
    expect(relative.closest("time")?.getAttribute("title")).toContain("2026");
    expect(screen.getByRole("button", { name: /Unread:\s*Sales Assistant update needs review/ })).toBeTruthy();
  });

  it("marks a notification read on the server before opening its saved destination", async () => {
    mocks.fetchNotificationsAction.mockResolvedValue({
      ok: true,
      unread: 1,
      hasMore: false,
      nextBefore: null,
      nextBeforeId: null,
      items: [item()],
    });
    mocks.markNotificationsReadAction.mockResolvedValue({ ok: true });
    render(<NotificationCenter initialUnread={1} initialNow={NOW} timeZone="UTC" viewAllHref="/notifications" />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));
    const row = await screen.findByRole("button", { name: /Sales Assistant update needs review/ });
    fireEvent.click(row);

    await waitFor(() => expect(mocks.markNotificationsReadAction).toHaveBeenCalledWith(["11111111-1111-4111-8111-111111111111"]));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/employees/sales-assistant"));
  });

  it("marks everything read and restores the count if the server call fails", async () => {
    mocks.fetchNotificationsAction.mockResolvedValue({
      ok: true,
      unread: 1,
      hasMore: false,
      nextBefore: null,
      nextBeforeId: null,
      items: [item()],
    });
    mocks.markNotificationsReadAction.mockResolvedValue({ ok: false, error: "Denied", code: "forbidden" });
    render(<NotificationCenter initialUnread={1} initialNow={NOW} timeZone="UTC" viewAllHref="/notifications" />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));
    await screen.findByText("Sales Assistant update needs review");
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Notifications, 1 unread/ })).toBeTruthy();
  });
});
