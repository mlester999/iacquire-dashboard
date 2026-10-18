"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import type { CrmActor } from "@/server/crm/actor";
import { resolveCrmActor } from "@/server/crm/request";
import { chooseInitialCrmProvider, recheckCrmSetup, requestCrmSetupReview, saveCrmSetupGuide, type saveGuideSchema } from "@/server/setup/crm-guide";

// The client's CRM setup guide (/crm/setup). The actor is resolved on the server: a client member acts on their own workspace, an agency
// person names the client and needs a support session for it. Each service re-checks who may do what (owner/admin edit; owner chooses the
// provider; only the client hands off for review) and validates its input.

const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  revalidatePath("/setup");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}`, "layout");
}

/** Autosave of the current step and answers. Doesn't revalidate: the screen already shows what it saved. */
export async function saveCrmSetupGuideAction(orgId: string | null, input: z.input<typeof saveGuideSchema>) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "crm.view");
    return saveCrmSetupGuide(actor, input);
  });
}

export async function chooseInitialCrmProviderAction(orgId: string | null, mode: "native" | "ghl") {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "crm.view");
    const res = await chooseInitialCrmProvider(actor, mode);
    refresh(actor);
    return res;
  });
}

export async function recheckCrmSetupAction(orgId: string | null) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "crm.view");
    const res = await recheckCrmSetup(actor);
    refresh(actor);
    return res;
  });
}

export async function requestCrmSetupReviewAction(orgId: string | null) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "crm.view");
    const res = await requestCrmSetupReview(actor);
    refresh(actor);
    return res;
  });
}
