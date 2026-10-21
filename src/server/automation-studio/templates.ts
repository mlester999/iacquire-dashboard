import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { loadBuilderOptions, type WorkflowBuilderOptions } from "@/server/crm/workflows/context";
import { listReviewTemplates } from "@/server/crm/reviews";
import { startStudioWorkflow } from "@/server/automation-studio/studio";
import { studioTemplate, type MessageChoice, type StageChoice, type StudioInputSpec, type StudioInputs } from "@/lib/automation-studio/templates";
import { validateDefinition, validationContextFrom, type ValidationIssue } from "@/lib/crm/workflow/spec";

/**
 * Creates an Automation Studio workflow from one of its ready-made templates, with the workspace's own choices.
 *
 * Every choice is looked up in the workspace here: a message template must be approved (its approved wording is never taken from the request), a tag,
 * calendar or form must exist, and a connection must be one of this workspace's own and of the right kind. Required choices must be made. The result is
 * an ordinary draft built in Automation Studio: the plan is required (checked when it is created), it is validated like any other, and it still needs
 * testing, publishing and, when it reaches outside iAcquire, the owner's approval of the exact version before it runs. A connection that isn't verified
 * yet is allowed: the draft says so and its steps wait.
 */
export async function createStudioFromTemplate(
  actor: CrmActor,
  key: string,
  input: { name?: string; inputs?: Record<string, unknown> } = {},
): Promise<{ id: string; issues: ValidationIssue[] }> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  const template = studioTemplate(key);
  if (!template) throw new AppError("not_found", "That template doesn't exist.");
  const name = (input.name?.trim() || template.name).slice(0, 80);
  const raw = input.inputs ?? {};
  const options = await withSystem((db) => loadBuilderOptions(db, actor.orgId));
  const reviewTemplates = template.inputs.some((s) => s.kind === "review_template") ? await listReviewTemplates(actor) : [];

  const values: StudioInputs = {};
  for (const spec of template.inputs) {
    const v = raw[spec.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (spec.required) throw new AppError("invalid_input", `${spec.label}: choose one.`);
      continue;
    }
    values[spec.key] = resolveInput(spec, v, options, reviewTemplates);
  }
  const definition = template.build(values, { newNonce: () => crypto.randomBytes(18).toString("base64url") });
  const issues = validateDefinition(definition, validationContextFrom(options));
  const { id } = await startStudioWorkflow(actor, { name, definition, label: `Started from the “${template.name}” template` });
  await withSystem((db) =>
    recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.template_used", targetType: "crm_workflow", targetId: id, result: "success", metadata: { template: key } }, db),
  );
  return { id, issues };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveInput(spec: StudioInputSpec, v: unknown, o: WorkflowBuilderOptions, reviewTemplates: Awaited<ReturnType<typeof listReviewTemplates>>): string | StageChoice | MessageChoice {
  const id = (x: unknown) => (typeof x === "string" && UUID.test(x) ? x : null);
  const bad = (what: string): never => {
    throw new AppError("invalid_input", `${spec.label}: ${what}`);
  };
  switch (spec.kind) {
    case "tag":
      return o.tags.some((t) => t.id === id(v)) ? (v as string) : bad("that tag doesn't exist.");
    case "user":
      return o.users.some((u) => u.id === id(v)) ? (v as string) : bad("that person isn't in this workspace or can't see contacts.");
    case "pipeline":
      return o.pipelines.some((p) => p.id === id(v)) ? (v as string) : bad("that pipeline doesn't exist.");
    case "calendar":
      return o.calendars.some((c) => c.id === id(v)) ? (v as string) : bad("that calendar doesn't exist.");
    case "form":
      return (o.forms ?? []).some((f) => f.id === id(v)) ? (v as string) : bad("that form doesn't exist.");
    case "employee":
      return typeof v === "string" && o.agents.some((a) => a.roleKey === v) ? v : bad("that AI employee isn't in this workspace.");
    case "slack":
    case "http": {
      const wanted = spec.kind === "slack" ? "slack_webhook" : "http";
      const c = (o.connections ?? []).find((x) => x.id === id(v));
      return c && c.kind === wanted ? c.id : bad(spec.kind === "slack" ? "choose one of your Slack connections." : "choose one of your HTTP connections.");
    }
    case "stage": {
      const s = v && typeof v === "object" ? (v as { pipelineId?: unknown; stageId?: unknown }) : {};
      const pipe = o.pipelines.find((p) => p.id === id(s.pipelineId));
      const stage = pipe?.stages.find((x) => x.id === id(s.stageId));
      return pipe && stage ? { pipelineId: pipe.id, stageId: stage.id } : bad("choose a stage of one of your pipelines.");
    }
    case "message_template":
    case "review_template": {
      const templateId = typeof v === "string" ? v : v && typeof v === "object" ? (v as { templateId?: unknown }).templateId : null;
      if (spec.kind === "review_template") {
        const r = reviewTemplates.find((x) => x.id === id(templateId));
        return r ? { templateId: r.id, contentHash: r.contentHash, channel: r.channel as MessageChoice["channel"] } : bad("that template isn't an approved review request (it needs the review link).");
      }
      const t = o.templates.find((x) => x.id === id(templateId));
      return t ? { templateId: t.id, contentHash: t.contentHash, channel: t.channel } : bad("that message template isn't approved for automated messages.");
    }
  }
}
