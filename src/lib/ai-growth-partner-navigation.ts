export type GrowthPartnerEntryState = { conversationId?: string | null } | null | undefined;

/** The permanent conversation is the primary destination once it exists; setup stays in the Control Center. */
export function growthPartnerPrimaryAction(state: GrowthPartnerEntryState) {
  if (state?.conversationId) return { href: "/growth-partner/conversation" as const, label: "Open AI Growth Partner" as const };
  if (state) return { href: "/growth-partner" as const, label: "Review Partner setup" as const };
  return { href: "/growth-partner" as const, label: "Set up AI Growth Partner" as const };
}
