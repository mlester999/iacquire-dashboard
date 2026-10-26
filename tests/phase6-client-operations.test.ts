import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadTeamWorkload } from "@/server/staff-workload/view";
import { createChannel } from "@/server/staff-messages/conversations";
import { sendMessage, listMessages } from "@/server/staff-messages/messages";
import { addProgressUpdate, assignProject, updateProjectStatus } from "@/server/projects/agency";
import { applyInScopeRevision, classifyChangeOrder, submitChangeOrder } from "@/server/projects/change-orders";
import { getProject } from "@/server/projects/client";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { agencyUser } from "./support/fixtures";
import { approvedProject, projectsWorld } from "./support/projects-world";
import { staffPerson, setMessages } from "./support/staff-messages";
import { resetRateLimits } from "./support/support-world";
import { setWorkload } from "./support/staff-workload";

// Phase 6.4: the project, workload and staff-message modules working as one system. A project the client asked for is visible in the
// assigned person's workload, the team can coordinate in a staff-only channel, and the client's own project view never carries that
// private conversation or an internal progress note. Synthetic people and workspaces only; nothing leaves the machine.

describe("a custom project across projects, workload and Staff Messages", () => {
  beforeEach(resetRateLimits);

  it("shows an assigned project in the team workload, keeps the staff channel private, and removes the project when it closes", async () => {
    const w = await projectsWorld();
    await setWorkload(true);
    await setMessages(true);
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    const manager = await staffPerson("agency_manager");
    const { id, quoteId } = await approvedProject(w, "Phase 6 integration project", { start: true });
    expect(quoteId).toBeTruthy();
    await assignProject(w.agency.staff, id, w.raw.staff.id);

    const team = await loadTeamWorkload(manager);
    const person = team.people.find((p) => p.userId === w.raw.staff.id);
    expect(person).toBeTruthy();
    const projectItem = person!.items.find((i) => i.source === "project" && i.itemId === id);
    expect(projectItem).toMatchObject({ title: "Phase 6 integration project", status: "in_development" });

    const privateText = "Private coordination: the client must not see this margin or the supplier delay.";
    const clientText = "The receptionist is configured and the first test calls are booked.";
    const internalText = "Internal: hold the handover until the telephony invoice is reconciled.";
    const channel = await createChannel(w.agency.superAdmin, {
      name: `Project ${id.slice(0, 8)}`,
      topic: "Delivery coordination for one custom project",
      visibility: "private",
      memberIds: [w.raw.staff.id, manager.id],
    });
    await sendMessage(w.agency.staff, {
      conversationId: channel.id,
      body: privateText,
      attachmentIds: [],
      clientMessageId: crypto.randomUUID(),
    });
    await addProgressUpdate(w.agency.staff, id, internalText, "internal");
    await addProgressUpdate(w.agency.staff, id, clientText, "client");

    const clientView = await getProject(w.ctx.owner, id);
    expect(clientView).toBeTruthy();
    const serialized = JSON.stringify(clientView);
    expect(serialized).toContain(clientText);
    expect(serialized).not.toContain(privateText);
    expect(serialized).not.toContain(internalText);

    // A change request raises the team's open first-look task, and classifying/applying it closes that task. The team's internal change note never reaches the client.
    const beforeChange = person!.items.find((i) => i.source === "project" && i.itemId === id)!.openReviewTasks;
    const changeTitle = "Add a second calendar";
    const changeNote = "Internal change note: the second calendar is outside the standard setup.";
    const change = await submitChangeOrder(w.ctx.owner, id, {
      title: changeTitle,
      description: "We now have two front desks and each needs its own calendar.",
    });
    const withChange = await loadTeamWorkload(manager);
    const changedItem = withChange.people.find((p) => p.userId === w.raw.staff.id)!.items.find((i) => i.source === "project" && i.itemId === id)!;
    expect(changedItem.openReviewTasks).toBe(beforeChange + 1);
    await classifyChangeOrder(w.agency.staff, change.id, { classification: "in_scope_revision", internalNotes: changeNote });
    await applyInScopeRevision(w.agency.staff, change.id, "Applied in the Phase 6 journey.");
    const afterChange = await loadTeamWorkload(manager);
    const settledItem = afterChange.people.find((p) => p.userId === w.raw.staff.id)!.items.find((i) => i.source === "project" && i.itemId === id)!;
    expect(settledItem.openReviewTasks).toBe(beforeChange);
    const afterChangeView = await getProject(w.ctx.owner, id);
    expect(JSON.stringify(afterChangeView)).toContain(changeTitle);
    expect(JSON.stringify(afterChangeView)).not.toContain(changeNote);

    // The team member who was assigned can read the channel; the client can never reach it.
    const staffUser = agencyUser(w.raw.staff, "agency_staff");
    const page = await listMessages(staffUser, channel.id, { limit: 50 });
    expect(page.messages.some((m) => m.body === privateText)).toBe(true);

    await updateProjectStatus(w.agency.staff, id, { status: "cancelled", reason: "Phase 6 integration test complete" });
    const after = await loadTeamWorkload(manager);
    const afterPerson = after.people.find((p) => p.userId === w.raw.staff.id);
    expect(afterPerson?.items.some((i) => i.source === "project" && i.itemId === id)).toBe(false);
  });
});
