import "server-only";
import { AppError } from "@/server/errors";
import { SOCIAL_CLIENT_ONLY_MESSAGE, socialAvailableIn } from "@/lib/social/workspace";

/** Refuses social media work in a workspace that is not a client's (an agency workspace). Call it before any permission check, so the reason given is the true one. */
export function assertSocialWorkspace(ctx: { org: { kind: "agency" | "client" } }): void {
  if (!socialAvailableIn(ctx.org.kind)) throw new AppError("forbidden", SOCIAL_CLIENT_ONLY_MESSAGE);
}
