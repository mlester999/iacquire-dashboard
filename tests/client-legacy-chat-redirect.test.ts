import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";
import { requireWorkforceContext } from "@/server/workforce/workspace-access";
import { getAgentByRole } from "@/server/workforce/service";
import ChatPage from "@/app/(chat)/chat/[slug]/page";

vi.mock("@/server/workforce/workspace-access", () => ({ requireWorkforceContext: vi.fn() }));
vi.mock("@/server/workforce/service", () => ({
  getAgentByRole: vi.fn(),
  listConfigVersions: vi.fn(),
  refreshAgentHealthIfStale: vi.fn(),
}));

describe("client legacy chat routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes client workspaces into the permanent Growth Partner conversation before loading a legacy profile", async () => {
    vi.mocked(requireWorkforceContext).mockResolvedValue({ org: { kind: "client" } } as unknown as OrgContext);

    let redirectError: unknown;
    try {
      await ChatPage({
        params: Promise.resolve({ slug: "lead-hunter" }),
        searchParams: Promise.resolve({}),
      });
    } catch (error) {
      redirectError = error;
    }

    expect(redirectError).toHaveProperty("digest");
    expect((redirectError as { digest: string }).digest).toContain("/growth-partner/conversation");
    expect(getAgentByRole).not.toHaveBeenCalled();
  });
});
