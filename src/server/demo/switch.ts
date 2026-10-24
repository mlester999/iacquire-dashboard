import "server-only";
import { env } from "@/server/env";

// The two environment switches of the prospect demo.
//   DEMO_PUBLIC_DISABLED  the emergency stop: every public demo page and route answers "temporarily unavailable" before any database read, and nothing is sent.
//   DEMO_ENABLED          this deployment's permission to run the demo at all (off by default). The Super Admin's own switch in the demo settings is the second one.
// Neither deletes anything, and neither touches the agency's Prospects screens.

export const demoPublicDisabled = (): boolean => env().DEMO_PUBLIC_DISABLED;
export const demoDeploymentEnabled = (): boolean => env().DEMO_ENABLED;
