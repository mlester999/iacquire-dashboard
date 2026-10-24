import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadTeamWorkload } from "@/server/staff-workload/view";
import { createChannel } from "@/server/staff-messages/conversations";
import { sendMessage, listMessages } from "@/server/staff-messages/messages";
import { addProgressUpdate, assignProject, updateProjectStatus } from "@/server/projects/agency";
import { getProject } from "@/server/projects/client";
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
