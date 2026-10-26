import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { metaProvider, metaSettings } from "@/server/social/providers/meta";
import { simulatedProvider } from "@/server/social/providers/simulated";
import type { SocialProvider } from "@/server/social/providers/types";

export type Adapter = "meta" | "simulated";

/** The simulated platform posts nothing anywhere, but it still must never be mistaken for a real connection: it does not exist in production. */
export const simulatedAllowed = () => env().NODE_ENV !== "production";

export function providerFor(adapter: Adapter): SocialProvider {
  if (adapter === "simulated") {
    if (!simulatedAllowed()) throw new AppError("forbidden", "Simulated social accounts are not available in production.");
    return simulatedProvider;
  }
  return metaProvider;
}

/** Whether publishing to the real platforms is switched on in this environment. Simulated accounts publish regardless: they reach nothing. */
export const livePublishingEnabled = () => metaSettings().writesEnabled;
