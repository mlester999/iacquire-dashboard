import "server-only";
import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { canDoBlueprint, isUuid, type AgencyUser } from "@/server/crm/blueprints/access";
import type { BlueprintUiPermissions } from "@/components/crm-blueprints/shared";

// Shared by the CRM Blueprints pages: what the signed-in person may do (for buttons and menus only; every service re-checks the exact step),
// and how a refused or missing record becomes a 404 without saying whether it exists.

export { isUuid };

export function blueprintPermissions(user: Pick<AgencyUser, "platformRole">): BlueprintUiPermissions {
  return {
    design: canDoBlueprint(user, "create"),
    publish: canDoBlueprint(user, "publish"),
    apply: canDoBlueprint(user, "apply"),
    export: canDoBlueprint(user, "export"),
    importFile: canDoBlueprint(user, "import_file"),
    importGhl: canDoBlueprint(user, "import_ghl"),
    capture: canDoBlueprint(user, "capture"),
  };
}

/** The record, or a 404 when it doesn't exist, isn't reachable for this person, or the address is malformed. */
export async function orNotFound<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof AppError && (err.code === "not_found" || err.code === "forbidden" || err.code === "invalid_input")) notFound();
    throw err;
  }
}

/** Secondary data for a page (starters, sources, clients): a refusal or a safe error shows as a note instead of breaking the page. */
export async function orNote<T>(load: () => Promise<T>, fallback: T): Promise<{ value: T; note: string | null }> {
  try {
    return { value: await load(), note: null };
  } catch (err) {
    if (err instanceof AppError) return { value: fallback, note: err.message };
    throw err;
  }
}
