// @vitest-environment jsdom
// The shared CRM action hook (dozens of screens use it): a change that was saved but leaves something for a person to look at carries a `warning` sentence in its data, and the hook
// shows it after the success. This renders a real consumer of the hook, with the action mocked, so removing the branch fails here.
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCrmAction, type ActionResult } from "@/components/crm/ui";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Consumer({ action, success }: { action: () => Promise<ActionResult<unknown>>; success?: string }) {
  const { run } = useCrmAction();
  return <button onClick={() => void run("save", action, success)}>Save</button>;
}

const press = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("useCrmAction and a warning that comes with a saved change", () => {
  it("shows the warning after the success message, and refreshes the page", async () => {
    const { toast } = await import("sonner");
    const warning = "3 upcoming bookings are outside these hours; review them. Nothing was cancelled or moved.";
    render(<Consumer action={async () => ({ ok: true, data: { id: "x", warning } })} success="Hours saved" />);
    press();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(warning, { duration: 12000 }));
    expect(toast.success).toHaveBeenCalledWith("Hours saved");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows no warning when there is none, when it is empty, or when it is not text", async () => {
    const { toast } = await import("sonner");
    for (const data of [{ id: "x", warning: null }, { id: "x", warning: "" }, { id: "x", warning: 3 }, { id: "x" }, null]) {
      cleanup();
      render(<Consumer action={async () => ({ ok: true, data })} success="Saved" />);
      press();
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      vi.mocked(toast.success).mockClear();
    }
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("shows no warning for a change that failed", async () => {
    const { toast } = await import("sonner");
    render(<Consumer action={async () => ({ ok: false, error: "Nope." })} />);
    press();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope."));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
