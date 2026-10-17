export type AgencyConnectionState = "setup_required" | "not_tested" | "verified" | "failed";
export type AgencyToolReviewState = "not_checked" | "verified" | "review_needed" | "incomplete" | "unavailable" | "acknowledged";

export interface AgencyWorkforceStatusInput {
  mappedCorrectly: boolean;
  profileId: string | null;
  gatewayId: string | null;
  hasCredential: boolean;
  profileCheckStatus: string | null;
  profileCheckProfileId: string | null;
  profileCheckGatewayId: string | null;
  profileIdentityVerified: boolean | null;
  gatewayStatus: string | null;
  toolPermissionsStatus: string | null;
  fullCapabilitiesAcknowledged?: boolean;
}

/** A profile check is current only when it matches the profile and gateway saved on the employee. */
export function deriveAgencyWorkforceStatus(input: AgencyWorkforceStatusInput): {
  connection: AgencyConnectionState;
  tools: AgencyToolReviewState;
  checkIsCurrent: boolean;
} {
  const checkIsCurrent = Boolean(
    input.profileCheckStatus
      && input.profileId
      && input.profileCheckProfileId === input.profileId
      && input.profileCheckGatewayId
      && input.profileCheckGatewayId === input.gatewayId
      && input.mappedCorrectly,
  );

  let connection: AgencyConnectionState;
  if (!input.mappedCorrectly || !input.gatewayId || !input.hasCredential) {
    connection = "setup_required";
  } else if (checkIsCurrent && input.profileCheckStatus === "verified" && input.profileIdentityVerified === true) {
    connection = "verified";
  } else if (checkIsCurrent && input.profileCheckStatus !== "not_configured" && input.profileCheckStatus !== "verified") {
    connection = "failed";
  } else if (input.gatewayStatus && ["error", "needs_attention", "disconnected", "offline"].includes(input.gatewayStatus)) {
    connection = "failed";
  } else {
    connection = "not_tested";
  }

  let tools: AgencyToolReviewState = "not_checked";
  if (checkIsCurrent && connection === "verified") {
    switch (input.toolPermissionsStatus) {
      case "verified": tools = "verified"; break;
      case "restricted": tools = "review_needed"; break;
      case "incomplete": tools = "incomplete"; break;
      case "unavailable": tools = "unavailable"; break;
      default: tools = "not_checked";
    }
  }

  // A verified internal profile may run under the explicit Super Admin acknowledgement.
  // Keep this distinct from verified inventory so the unresolved tool inventory remains visible.
  if (input.fullCapabilitiesAcknowledged && checkIsCurrent && connection === "verified" && tools !== "verified") tools = "acknowledged";

  return { connection, tools, checkIsCurrent };
}
