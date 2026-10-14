import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { answerHelpQuestion, catalogHelpArticles } from "@/server/help/service";
import { createProjectRequest } from "@/server/projects/client";

let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
let ownerA: { id: string; email: string };
let ownerB: { id: string; email: string };
let projectId: string;

beforeAll(async () => {
  orgA = await createOrg({ name: "Assistant Dental" });
  orgB = await createOrg({ name: "Assistant Roofing" });
  ownerA = await createUser();
  ownerB = await createUser();
  await addMember(orgA.id, ownerA.id, "owner");
  await addMember(orgB.id, ownerB.id, "owner");
  const created = await createProjectRequest(ctxFor(ownerA, orgA, "owner"), {
    title: "Secret loyalty app for Alpha",
    problem: "Customers forget to rebook their appointments with us.",
    currentProcess: "The front desk phones people one by one.",
    desiredOutcome: "Automatic reminders and rebooking prompts for every patient.",
  });
  projectId = created.id;
});

describe("iAcquire Assistant: services, pricing and projects", () => {
  it("builds help articles from the published catalog, so prices match what the agency set", async () => {
    const articles = await catalogHelpArticles();
    const voice = articles.find((a) => a.id === "service-ai-voice-receptionist")!;
    expect(voice.body).toContain("$699–$1,499");
    expect(voice.body).toMatch(/confirmed in writing/);
    const pricing = articles.find((a) => a.id === "pricing-core-vs-optional")!;
    expect(pricing.body).toContain("one-time setup fee of $1,499");
    expect(pricing.body).toContain("$299/month");
    expect(pricing.body).toMatch(/From \$1,500|from \$1,500/);
    expect(pricing.body).toMatch(/nothing is charged automatically/i);
  });

  it("answers a service price question with the published range and a link to request it", async () => {
    const a = await answerHelpQuestion("How much is the AI voice receptionist?", { firstName: null });
    expect(a.mode).toBe("help_search");
    expect(a.content).toContain("$699–$1,499");
    expect(a.links.map((l) => l.href)).toContain("/projects/new?service=ai-voice-receptionist");
    expect(a.content).not.toMatch(/guarantee|unlimited|lifetime/i);
  });

  it("keeps the core offer, optional maintenance and add-ons clearly apart", async () => {
    const a = await answerHelpQuestion("What is the pricing for maintenance?", { firstName: null });
    expect(a.content).toMatch(/optional/i);
    expect(a.content).toContain("$299/month");
    const b = await answerHelpQuestion("How much does iAcquire cost per month?", { firstName: null });
    expect(b.content).toMatch(/no required monthly subscription/);
  });

  it("points a custom-build request at the request form without inventing a quote or deadline", async () => {
    const a = await answerHelpQuestion("Can you build me something custom, like a client portal?", { firstName: null, ctx: ctxFor(ownerA, orgA, "owner") });
    expect(a.links.map((l) => l.href)).toContain("/projects/new");
    expect(a.content).not.toMatch(/within \d+ (days|weeks)|will be ready by|we guarantee/i);
  });

  it("members, who can't submit requests, are sent to the marketplace instead of the form", async () => {
    const member = await createUser();
    await addMember(orgA.id, member.id, "member");
    const a = await answerHelpQuestion("Can you build me something custom?", { firstName: null, ctx: ctxFor(member, orgA, "member") });
    expect(a.links.map((l) => l.href)).toContain("/add-ons");
    expect(a.links.map((l) => l.href)).not.toContain("/projects/new");
  });

  it("reports the user's own project status through tenant-scoped data", async () => {
    const a = await answerHelpQuestion("What's the status of my project?", { firstName: null, ctx: ctxFor(ownerA, orgA, "owner") });
    expect(a.content).toContain("Secret loyalty app");
    expect(a.content).toContain("Request Submitted");
    expect(a.links.map((l) => l.href)).toContain(`/projects/${projectId}`);
  });

  it("never reveals another company's projects", async () => {
    const a = await answerHelpQuestion("What's the status of my project?", { firstName: null, ctx: ctxFor(ownerB, orgB, "owner") });
    expect(a.content).not.toContain("Secret loyalty app");
    expect(a.links.map((l) => l.href)).not.toContain(`/projects/${projectId}`);
    expect(a.content).toMatch(/no custom projects yet/i);
  });

  it("gives no account data without a signed-in workspace", async () => {
    const a = await answerHelpQuestion("What's the status of my project?", { firstName: null });
    expect(a.content).not.toContain("Secret loyalty app");
  });

  it("still offers a real person for human help", async () => {
    const a = await answerHelpQuestion("I want to talk to a real person about my quote", { firstName: null });
    expect(a.mode).toBe("escalation");
    expect(a.links.map((l) => l.href)).toContain("/support");
  });

  it("describes the founder portfolio honestly", async () => {
    const a = await answerHelpQuestion("Do you have case studies or examples of past work?", { firstName: null });
    expect(a.content).toMatch(/aren't iAcquire client results/);
    expect(a.links.map((l) => l.href)).toContain("/our-work");
  });
});
