import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ctx: null as null | {
    user: { id: string; platformRole: "none" | "agency_staff" | "agency_manager" | "agency_super_admin" };
    org: { orgId: string; kind: "agency" | "client"; name: string; timezone: string };
    can: (permission: string) => boolean;
  },
}));

const calls = vi.hoisted(() => ({
  getAgentByRole: vi.fn(async () => ({ id: "55555555-5555-4555-8555-555555555555", role_key: "appointment_setter" as const })),
  createConfigVersion: vi.fn(),
  loadCompanyContext: vi.fn(async () => ({
    companyName: "iAcquire",
    orgKind: "agency" as const,
    industry: "AI-powered business operations and client acquisition software",
    website: "",
    description: "Confirmed internal profile description.",
    services: "Confirmed internal services.",
    idealCustomers: "Confirmed internal ideal customers.",
    operatingArea: "",
    goals: ["more_leads"],
  })),
  getOnboardingSession: vi.fn(),
  generateEmployeeSettings: vi.fn(async () => ({
    appointment_setter: {
      settings: {
        personality: "A precise and welcoming scheduling partner.",
        characterTraits: "Patient, organized and careful.",
        communicationStyle: "Ask concise questions and state verified availability.",
        responseBehavior: "Ask an owner when meeting facts are missing.",
        operatingProcedures: "Check the connected calendar and keep booking states clear.",
        proactiveResponsibilities: "Review pending requests only for an authorized schedule.",
        reportingBehavior: "State the source, time zone, approval and confirmation state.",
        responsibilities: "Prepare scheduling requests through the approved workflow.",
        goals: "Reduce scheduling friction while keeping availability accurate.",
      },
      source: "ai" as const,
      fallbackFields: [],
    },
  })),
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
  listConversations: vi.fn(async () => []),
  saveEmployeeKnowledgeEntry: vi.fn(async () => ({ id: "66666666-6666-4666-8666-666666666666" })),
  dispatchCapabilityJob: vi.fn(async () => ({ jobId: "77777777-7777-4777-8777-777777777777" })),
  requestProvisioning: vi.fn(async () => 6),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    requireOrgContextOrThrow: async () => {
      if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
      return state.ctx;
    },
  };
});
vi.mock("@/server/db", () => ({
  withSystem: vi.fn(),
  withUser: vi.fn(async (_userId: string, callback: (db: {
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  }) => Promise<unknown>) => callback({
    query: async <T>(sql: string) => {
      if (sql.includes("ai_preferences")) return { rows: [{ ai_preferences: { tone: "friendly", replyLength: "concise", language: "English" } } as T] };
      if (sql.includes("company_knowledge")) return { rows: [{ content: "Approved iAcquire knowledge." } as T] };
      return { rows: [] as T[] };
    },
  })),
}));
vi.mock("@/server/workforce/service", () => ({
  createConfigVersion: calls.createConfigVersion,
  editableSettings: vi.fn(),
  getAgentByRole: calls.getAgentByRole,
  loadCompanyContext: calls.loadCompanyContext,
  rollbackToVersion: vi.fn(),
}));
vi.mock("@/server/onboarding/service", () => ({ getOnboardingSession: calls.getOnboardingSession }));
vi.mock("@/server/onboarding/employee-generator", () => ({ generateEmployeeSettings: calls.generateEmployeeSettings }));
vi.mock("@/server/security/rate-limit", () => ({
  consumeRateLimit: calls.consumeRateLimit,
  RATE_LIMITS: { onboardingAssistByOrg: "onboarding-assist" },
}));
vi.mock("@/server/chat/service", () => ({
  deleteConversation: vi.fn(),
  getConversation: vi.fn(),
  listConversations: calls.listConversations,
  renameConversation: vi.fn(),
}));
vi.mock("@/server/workforce/knowledge", () => ({
  archiveEmployeeKnowledgeEntry: vi.fn(),
  assignKnowledgeDocument: vi.fn(),
  saveEmployeeKnowledgeEntry: calls.saveEmployeeKnowledgeEntry,
  unassignKnowledgeDocument: vi.fn(),
}));
vi.mock("@/server/workforce/provisioning", () => ({ requestProvisioning: calls.requestProvisioning }));
vi.mock("@/server/knowledge/service", () => ({ reprocessKnowledgeDocument: vi.fn() }));
vi.mock("@/server/workforce/capability-dispatch", () => ({ dispatchCapabilityJob: calls.dispatchCapabilityJob }));
vi.mock("@/server/workforce/schedules", () => ({ deleteSchedule: vi.fn(), saveSchedule: vi.fn(), setScheduleEnabled: vi.fn() }));
vi.mock("@/server/workforce/triggers", () => ({ deleteTrigger: vi.fn(), saveTrigger: vi.fn(), setTriggerEnabled: vi.fn() }));
vi.mock("@/server/workforce/finding-actions", () => ({ createFindingTask: vi.fn() }));
vi.mock("@/server/workforce/reports", () => ({ acknowledgeProactiveReport: vi.fn() }));

import { searchConversationsAction } from "@/app/actions/chat";
import { startReviewAction } from "@/app/actions/work";
import { saveEmployeeKnowledgeEntryAction } from "@/app/actions/workforce-knowledge";
import { regenerateEmployeeSettingsAction, requestSetupAction, saveAgentSettingsAction } from "@/app/actions/workforce";
import type { OnboardingData } from "@/lib/agent-settings";

const internalContext = (platformRole: "agency_staff" | "agency_manager" | "agency_super_admin") => ({
  user: { id: "11111111-1111-4111-8111-111111111111", platformRole },
  org: { orgId: "22222222-2222-4222-8222-222222222222", kind: "agency" as const, name: "iAcquire", timezone: "UTC" },
  can: () => true,
});

beforeEach(() => {
  state.ctx = internalContext("agency_staff");
  calls.getAgentByRole.mockClear();
  calls.createConfigVersion.mockClear();
  calls.loadCompanyContext.mockClear();
  calls.getOnboardingSession.mockReset();
  calls.generateEmployeeSettings.mockClear();
  calls.consumeRateLimit.mockClear();
  calls.consumeRateLimit.mockResolvedValue({ allowed: true });
  calls.listConversations.mockClear();
  calls.saveEmployeeKnowledgeEntry.mockClear();
  calls.dispatchCapabilityJob.mockClear();
  calls.requestProvisioning.mockClear();
});

describe("employee workspace server action boundary", () => {
  it("refuses agency staff at configuration, chat, knowledge and task entry points", async () => {
    const results = await Promise.all([
      saveAgentSettingsAction("sales_assistant", {}),
      searchConversationsAction("sales_assistant", ""),
      saveEmployeeKnowledgeEntryAction("55555555-5555-4555-8555-555555555555", { title: "Note", content: "Text" }),
      startReviewAction("lead_research"),
      requestSetupAction(),
    ]);

    for (const result of results) expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.getAgentByRole).not.toHaveBeenCalled();
    expect(calls.listConversations).not.toHaveBeenCalled();
    expect(calls.saveEmployeeKnowledgeEntry).not.toHaveBeenCalled();
    expect(calls.dispatchCapabilityJob).not.toHaveBeenCalled();
    expect(calls.requestProvisioning).not.toHaveBeenCalled();
  });

  it("keeps the internal Super Admin route available through normal validation", async () => {
    state.ctx = internalContext("agency_super_admin");
    const result = await saveAgentSettingsAction("sales_assistant", {});
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(calls.getAgentByRole).toHaveBeenCalledOnce();
  });

  it("generates internal employee suggestions from the agency profile without creating onboarding data or saving a version", async () => {
    state.ctx = internalContext("agency_super_admin");

    const result = await regenerateEmployeeSettingsAction("appointment_setter");

    expect(result).toMatchObject({ ok: true, data: { source: "ai", fallbackFields: [] } });
    expect(calls.getOnboardingSession).not.toHaveBeenCalled();
    expect(calls.loadCompanyContext).toHaveBeenCalledOnce();
    expect(calls.generateEmployeeSettings).toHaveBeenCalledOnce();
    expect(calls.createConfigVersion).not.toHaveBeenCalled();
    const [data, knowledge, completion, orgId] = calls.generateEmployeeSettings.mock.calls[0] as unknown as [OnboardingData, string[], undefined, string];
    expect(data.business).toMatchObject({
      companyName: "iAcquire",
      industry: "AI-powered business operations and client acquisition software",
      description: "Confirmed internal profile description.",
      services: "Confirmed internal services.",
      idealCustomers: "Confirmed internal ideal customers.",
    });
    expect(data.communication).toMatchObject({ tone: "friendly", replyLength: "concise", language: "English" });
    expect(data.workforce).toEqual({ selected: ["appointment_setter"], answers: {} });
    expect(knowledge).toEqual(["Approved iAcquire knowledge."]);
    expect(completion).toBeUndefined();
    expect(orgId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("keeps client generation behind an approved onboarding submission", async () => {
    state.ctx = {
      ...internalContext("agency_super_admin"),
      user: { id: "11111111-1111-4111-8111-111111111111", platformRole: "none" },
      org: { orgId: "22222222-2222-4222-8222-222222222222", kind: "client", name: "Client", timezone: "UTC" },
    };
    calls.getOnboardingSession.mockResolvedValue({ status: "draft", hasUnsubmittedChanges: false });

    const result = await regenerateEmployeeSettingsAction("appointment_setter");

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(calls.generateEmployeeSettings).not.toHaveBeenCalled();
    expect(calls.loadCompanyContext).not.toHaveBeenCalled();
  });
});
