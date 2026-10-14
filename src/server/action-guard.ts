import "server-only";
import { z } from "zod";
import { actionError, type ErrorCode } from "@/server/errors";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ErrorCode };

/** Runs a server action body and converts thrown errors into the portal's `{ ok, error }` result shape. */
export async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the form and try again.", code: "invalid_input" };
    return actionError(err);
  }
}
