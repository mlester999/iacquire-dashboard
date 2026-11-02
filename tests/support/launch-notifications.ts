import { vi } from "vitest";
import { resetEnvCache } from "@/server/env";

/**
 * The deployment switch for launch notices (LAUNCH_NOTIFICATIONS_ENABLED) is off by default, so a client that was already using the product is never told anything unexpectedly. A test
 * about the notices themselves switches it on with this; tests/launch-notifications.test.ts covers the default (off) and the per-workspace setting.
 */
export function launchNoticesOn(): void {
  vi.stubEnv("LAUNCH_NOTIFICATIONS_ENABLED", "true");
  resetEnvCache();
}
