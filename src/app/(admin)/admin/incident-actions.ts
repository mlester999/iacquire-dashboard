"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { acknowledgeIncident, addIncidentNote, incidentTimeline, resolveIncidentManually } from "@/server/ops/incidents";

const uuid = z.string().uuid();

async function run<T>(fn: (user: Awaited<ReturnType<typeof requireAgencyOrThrow>>) => Promise<T>) {
  try {
    const user = await requireAgencyOrThrow();
    const data = await fn(user);
    revalidatePath("/admin/health");
    return { ok: true as const, data };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

// Each service call re-checks that this staff member may see the incident's client, so a forged id gets "not found".
export const acknowledgeIncidentAction = async (id: string) => run(async (u) => void (await acknowledgeIncident(u, uuid.parse(id))));
export const addIncidentNoteAction = async (id: string, note: string) => run(async (u) => void (await addIncidentNote(u, uuid.parse(id), note)));
export const resolveIncidentAction = async (id: string, note: string) => run(async (u) => void (await resolveIncidentManually(u, uuid.parse(id), note)));
export const incidentTimelineAction = async (id: string) => run((u) => incidentTimeline(u, uuid.parse(id)));
