import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { PROVIDER_LABELS } from "@/lib/esign/state";
import { pandaDocProvider } from "@/server/esign/providers/pandadoc";
import { simulatedProvider } from "@/server/esign/providers/simulated";
import type { EsignProvider } from "@/server/esign/providers/types";

export type Adapter = "pandadoc" | "simulated";
export type ConnectionMode = "sandbox" | "live" | "simulated";

/** The simulated service signs nothing for anyone, but it still must never be mistaken for a real connection: it does not exist in production. */
export const simulatedAllowed = (): boolean => env().NODE_ENV !== "production";

export function providerFor(adapter: Adapter): EsignProvider {
  if (adapter === "simulated") {
    if (!simulatedAllowed()) throw new AppError("forbidden", "The simulated signing service is not available in production.");
    return simulatedProvider;
  }
  return pandaDocProvider;
}

/** Whether requests may be created and sent at real signing services in this environment. The simulated service is not affected: it reaches nothing. */
export const liveEsignWritesEnabled = (): boolean => env().ESIGN_WRITES_ENABLED;

export const providerLabel = (adapter: Adapter): string => PROVIDER_LABELS[adapter];
