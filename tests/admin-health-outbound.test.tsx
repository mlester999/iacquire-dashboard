import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCard } from "@/components/admin/service-health-card";
import { outboundHealth, outboundPresentation } from "@/server/admin/health";
import { resetEnvCache } from "@/server/env";

const WRITES = [
  "GHL_WRITES_ENABLED",
  "RESEND_WRITES_ENABLED",
  "TWILIO_WRITES_ENABLED",
  "META_WHATSAPP_WRITES_ENABLED",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

function cardHtml(presentation: ReturnType<typeof outboundPresentation>) {
  return renderToStaticMarkup(createElement(ServiceCard, {
    icon: createElement("span", null),
    name: "Outbound messaging",
    state: presentation.state,
    detail: presentation.detail,
    note: presentation.note,
  }));
}

describe("admin health outbound messaging card", () => {
  it("says switched off and lists every write switch without exposing secrets", () => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", "false");
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    for (const name of WRITES) vi.stubEnv(name, "false");
    vi.stubEnv("RESEND_API_KEY", "outbound-health-secret-canary");
    vi.stubEnv("SLACK_SUPPORT_WEBHOOK_URL", "https://hooks.example.test/outbound-health-secret");
    resetEnvCache();

    const outbound = outboundHealth();
    const html = cardHtml(outboundPresentation(outbound));
    expect(outbound.messagingEnabled).toBe(false);
    expect(html).toContain("Outbound messaging");
    expect(html).toContain("Switched off");
    for (const write of outbound.writes) expect(html).toContain(`${write.name}: off`);
    expect(html).toContain("no prospect or customer outreach can be sent");
    expect(html).not.toContain("outbound-health-secret");
  });

  it("names enabled provider writes without calling them verified", () => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", "true");
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_WRITES_ENABLED", "true");
    for (const name of WRITES.filter((name) => name !== "RESEND_WRITES_ENABLED")) vi.stubEnv(name, "false");
    vi.stubEnv("RESEND_API_KEY", "second-outbound-health-secret");
    resetEnvCache();

    const outbound = outboundHealth();
    const html = cardHtml(outboundPresentation(outbound));
    expect(outbound.messagingEnabled).toBe(true);
    expect(html).toContain("Configured · not verified");
    expect(html).toContain("RESEND_WRITES_ENABLED: on");
    expect(html).toContain("EMAIL_PROVIDER=resend: on");
    expect(html).not.toContain("Verified");
    expect(html).not.toContain("second-outbound-health-secret");
  });
});
