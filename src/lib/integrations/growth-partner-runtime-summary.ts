export function growthPartnerRuntimeSummary(online: number, enabled: number) {
  if (online > 0) {
    return {
      value: "Ready",
      status: "connected" as const,
      detail: "One dedicated runtime passed its latest readiness check.",
      body: "Your AI Growth Partner uses one dedicated runtime profile in this private workspace.",
    };
  }
  if (enabled > 0) {
    return {
      value: "Needs attention",
      status: "degraded" as const,
      detail: "A saved runtime profile needs its latest readiness checks to pass.",
      body: "Your AI Growth Partner has one saved runtime profile, but its latest readiness checks need attention.",
    };
  }
  return {
    value: "Not set up",
    status: "not_configured" as const,
    detail: "Setup creates one private runtime for your AI Growth Partner.",
    body: "A dedicated AI Growth Partner runtime will appear here after setup.",
  };
}
