// @vitest-environment jsdom
// The Knowledge Center's History drawer: every saved version is listed with what happened to it, the version in use is marked, and a person who may edit can restore any other
// one (a person who may only view can read the history and cannot restore). The two actions behind it are fakes; nothing here reaches a server.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/knowledge" }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { KnowledgeCenter, type KnowledgeRevisionView } from "@/components/knowledge/knowledge-center";

const CURRENT = "Open Monday to Friday, 9 to 5.";
const section = (key: string, label: string, over: Record<string, unknown> = {}) => ({ key, label, hint: "A hint.", content: "", version: 0, updatedAt: null, appliedAt: null, held: false, updatedBy: null, ...over });
const sections = [
  section("business_hours", "Business hours", { content: CURRENT, version: 3, updatedAt: "2026-10-26T10:00:00.000Z", appliedAt: "2026-10-26T10:00:00.000Z" }),
  section("faq", "Frequently asked questions"),
];
const revision = (over: Partial<KnowledgeRevisionView>): KnowledgeRevisionView => ({
  id: "r", version: 1, content: "", review_status: "approved", risk_flags: [], source: "client", restored_from_version: null, created_at: "2026-10-26T09:00:00.000Z", actor_name: "Owner Person", ...over,
});
const revisions: KnowledgeRevisionView[] = [
  revision({ id: "r4", version: 4, content: "A flagged edit that waits.", review_status: "held", risk_flags: ["prompt_injection"] }),
  revision({ id: "r3", version: 3, content: CURRENT }),
  revision({ id: "r2", version: 2, content: "Open Monday to Saturday, 8 to 6.", source: "onboarding" }),
  revision({ id: "r1", version: 1, content: "Text before history began.", source: "baseline", actor_name: null }),
];

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

async function openHistory(canEdit: boolean) {
  const loadHistory = vi.fn(async () => ({ ok: true as const, data: revisions }));
  const restoreRevision = vi.fn(async () => ({ ok: true as const, data: { held: false } }));
  render(<KnowledgeCenter sections={sections} documents={[]} canEdit={canEdit} accept=".txt" timeZone="UTC" loadHistory={loadHistory} restoreRevision={restoreRevision} />);
  fireEvent.click(screen.getByRole("button", { name: "Version history for Business hours" }));
  await waitFor(() => expect(screen.getByText("Version 3")).toBeTruthy());
  return { loadHistory, restoreRevision };
}

describe("the History drawer", () => {
  it("is offered only for a section that has been saved", () => {
    render(<KnowledgeCenter sections={sections} documents={[]} canEdit accept=".txt" timeZone="UTC" loadHistory={async () => ({ ok: true as const, data: [] })} restoreRevision={async () => ({ ok: true as const, data: { held: false } })} />);
    expect(screen.getByRole("button", { name: "Version history for Business hours" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Version history for Frequently asked questions" })).toBeNull();
  });

  it("lists every version with what happened to it, and marks only the approved version that is in use", async () => {
    const { loadHistory } = await openHistory(true);
    expect(loadHistory).toHaveBeenCalledWith("business_hours");
    expect(screen.getAllByText("In use now")).toHaveLength(1);
    const card = (version: number) => screen.getByText(`Version ${version}`).closest("div")!.parentElement as HTMLElement;
    expect(within(card(3)).getByText("In use now")).toBeTruthy();
    expect(within(card(4)).getByText("Waiting for review")).toBeTruthy();
    expect(within(card(4)).queryByText("In use now")).toBeNull();
    expect(within(card(2)).getByText("Approved")).toBeTruthy();
    expect(within(card(2)).queryByText("In use now")).toBeNull();
    expect(screen.getByText(/From onboarding/)).toBeTruthy();
    expect(screen.getByText(/Text before history began/, { selector: "p" })).toBeTruthy();
  });

  it("lets an editor restore any version except the one in use, and restoring runs the action for that version", async () => {
    const { restoreRevision } = await openHistory(true);
    expect(screen.queryByRole("button", { name: "Restore version 3 of Business hours" })).toBeNull();
    for (const version of [4, 2, 1]) expect(screen.getByRole("button", { name: `Restore version ${version} of Business hours` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore version 2 of Business hours" }));
    await waitFor(() => expect(restoreRevision).toHaveBeenCalledWith("business_hours", "r2"));
  });

  it("shows the history to a person who may only view, with no way to restore", async () => {
    const { restoreRevision } = await openHistory(false);
    expect(screen.getByText("Version 2")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Restore version/ })).toHaveLength(0);
    expect(restoreRevision).not.toHaveBeenCalled();
  });

  it("offers no History at all where the page did not wire the actions", () => {
    render(<KnowledgeCenter sections={sections} documents={[]} canEdit accept=".txt" timeZone="UTC" />);
    expect(screen.queryByRole("button", { name: /Version history/ })).toBeNull();
  });
});
