"use server";

import { revalidatePath } from "next/cache";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { confirmContactIdentity } from "@/server/messaging/consent-identity";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A person confirms that a number or address on a contact is the customer's own, and says how they know. Recorded on the address and in the audit trail. */
export async function confirmIdentityAction(identityId: string, how: string) {
  try {
    const ctx = await requireOrgContextOrThrow("contacts.edit");
    if (!uuid.test(identityId)) throw new AppError("invalid_input", "Choose a valid number or address.");
    const result = await confirmContactIdentity(ctx, { identityId, how });
    revalidatePath("/inbox");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
