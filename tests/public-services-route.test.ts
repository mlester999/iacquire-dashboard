import { describe, expect, it, vi } from "vitest";
import { MAINTENANCE_INCLUDES_FALLBACK } from "@/lib/demo/showroom/content";

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requestMeta: async () => ({ ip: "198.51.100.10", userAgent: "vitest" }),
}));

vi.mock("@/server/security/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/security/rate-limit")>()),
  consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

import { GET } from "@/app/api/public/services/route";

describe("public services feed", () => {
  it("returns the current maintenance copy without exposing legacy roles or internal overlap notes", async () => {
    const response = await GET();
    const payload = await response.json() as {
      maintenance: { included: string[] } | null;
      addOns: { services: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(payload.maintenance?.included).toEqual(MAINTENANCE_INCLUDES_FALLBACK);
    expect(payload.addOns.services.every((service) => !("coreOverlapNote" in service))).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/AI employees|AI employee|AI team|Lead Hunter|Appointment Setter|Sales Assistant|CRM Manager|Performance Analyst|Hermes/i);
  });
});
