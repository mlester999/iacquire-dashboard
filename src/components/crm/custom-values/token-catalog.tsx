"use client";

import * as React from "react";
import type { CustomValueTokenDef } from "@/lib/messaging/tokens";

// The workspace's configuration values for the template screens: the token picker lists them, the live checks accept exactly these keys
// (as the server does when a template is saved) and previews show their labels and current values. Provided once by the screen that loads
// them, so the editors and pickers deep inside it don't need the list passed through every component.

const CustomValueTokensContext = React.createContext<readonly CustomValueTokenDef[] | null>(null);

export function CustomValueTokensProvider({ values, children }: { values: readonly CustomValueTokenDef[]; children: React.ReactNode }) {
  return <CustomValueTokensContext.Provider value={values}>{children}</CustomValueTokensContext.Provider>;
}

/**
 * The workspace's configuration values, or null outside a provider (the screen didn't load them). The validator treats null as "none" (the
 * server's rule); highlighting treats it as "not known here", so a well-formed {{custom_values.<key>}} isn't shown as a mistake.
 */
export function useCustomValueTokens(): readonly CustomValueTokenDef[] | null {
  return React.useContext(CustomValueTokensContext);
}
