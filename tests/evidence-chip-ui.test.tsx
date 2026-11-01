// @vitest-environment jsdom
// The chip that says what kind of reply a chat message is. A missing, legacy or damaged marker renders nothing, "Done" appears only for a confirmed action, and the time a model's
// records were read is shown in the viewer's own time zone.
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EvidenceChip } from "@/components/chat/evidence-chip";
import { EVIDENCE_CLASSES } from "@/lib/evidence-class";

afterEach(cleanup);

const READ_AT = "2026-10-26T06:00:00.000Z";
const render1 = (evidence: unknown, timeZone?: string) => render(<EvidenceChip evidence={evidence} timeZone={timeZone} />);

describe("the evidence chip", () => {
  it.each([
    ["model_response", "Written by AI"],
    ["record_retrieval", "Read from your records"],
    ["proposed_change", "Proposed, not applied"],
    ["approved_write", "Approved and applied"],
    ["completed_action", "Done, confirmed"],
    ["system_notice", "System notice"],
  ])("shows %s as %s, with the class on the element and an explanation for a screen reader and a tooltip", (cls, label) => {
    const { container } = render1({ v: 1, class: cls });
    const chip = container.querySelector("[data-evidence-class]") as HTMLElement;
    expect(chip.getAttribute("data-evidence-class")).toBe(cls);
    expect(chip.textContent).toContain(label);
    expect(chip.getAttribute("title")?.length).toBeGreaterThan(20);
    expect(chip.querySelector(".sr-only")?.textContent).toContain(chip.getAttribute("title") as string);
  });

  it("says Done or Completed only for a confirmed action, anywhere in what it renders", () => {
    for (const cls of EVIDENCE_CLASSES) {
      const { container } = render1({ v: 1, class: cls });
      const text = `${container.textContent} ${container.querySelector("[title]")?.getAttribute("title")}`;
      if (cls === "completed_action") expect(text).toMatch(/\bdone\b/i);
      else expect(text, cls).not.toMatch(/\b(done|completed?)\b/i);
      cleanup();
    }
  });

  it("names when a model's records were read in the viewer's own zone, and which areas", () => {
    const marker = { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "calendar", state: "ready" }, { id: "crm", state: "empty" }] } };
    const manila = render1(marker, "Asia/Manila");
    expect(manila.container.textContent).toContain("Written by AI, using records read at 2:00 PM");
    expect(manila.container.querySelector("[title]")?.getAttribute("title")).toContain("calendar (ready)");
    cleanup();
    const chicago = render1(marker, "America/Chicago");
    expect(chicago.container.textContent).toContain("1:00 AM");
  });

  it("does not claim records were read when none were", () => {
    const { container } = render1({ v: 1, class: "model_response" });
    expect(container.textContent).toContain("Written by AI");
    expect(container.textContent).not.toContain("using records");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("No verified records were read");
  });

  it("warns on a model reply flagged for describing an action nobody recorded", () => {
    const { container } = render1({ v: 1, class: "model_response", claims: "unbacked_action_claim" });
    expect(container.textContent).toContain("unconfirmed");
  });

  it.each<[string, unknown]>([
    ["no marker (a legacy message)", null],
    ["an undefined marker", undefined],
    ["a string", "system_notice"],
    ["an array", [{ v: 1, class: "system_notice" }]],
    ["an unknown class", { v: 1, class: "guess" }],
    ["a wrong version", { v: 2, class: "system_notice" }],
    ["an unknown key", { v: 1, class: "system_notice", extra: 1 }],
    ["records on a notice", { v: 1, class: "system_notice", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } }],
    ["records with an unreadable time", { v: 1, class: "model_response", records: { readAt: "later", areas: [{ id: "crm", state: "ready" }] } }],
    ["an area with an unknown state", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "fine" }] } }],
  ])("renders nothing for %s", (_label, evidence) => {
    const { container } = render1(evidence);
    expect(container.innerHTML).toBe("");
  });

  it("falls back to UTC for a time zone it does not know, instead of failing the page", () => {
    const { container } = render1({ v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } }, "Not/AZone");
    expect(container.textContent).toContain("6:00 AM");
  });
});
