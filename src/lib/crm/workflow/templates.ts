// Built-in workflow templates: common automations a workspace starts from. Each asks for the few choices only the workspace can make (which
// tag, which stage, which approved message) and builds an ordinary draft definition, which is then validated, published and (when it
// sends messages) approved like any other. Pure.
import type { MessageChannel, TriggerType, WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";

export type TemplateInputKind = "tag" | "user" | "pipeline" | "stage" | "open_stage" | "message_template";

export interface TemplateInputSpec {
  key: string;
  label: string;
  help: string;
  kind: TemplateInputKind;
  required: boolean;
}

export type StageChoice = { pipelineId: string; stageId: string };
export type MessageChoice = { templateId: string; contentHash: string; channel: MessageChannel };
export type TemplateInputs = Record<string, string | StageChoice | MessageChoice | null | undefined>;

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  trigger: TriggerType;
  /** True when the workflow sends customer messages, which an owner approves before it runs. */
  sendsMessages: boolean | "optional";
  inputs: TemplateInputSpec[];
  build: (inputs: TemplateInputs) => WorkflowDefinition;
}

const str = (v: TemplateInputs[string]) => (typeof v === "string" && v ? v : null);
const stage = (v: TemplateInputs[string]) => (v && typeof v === "object" && "stageId" in v ? (v as StageChoice) : null);
const message = (v: TemplateInputs[string]) => (v && typeof v === "object" && "templateId" in v ? (v as MessageChoice) : null);

/** Links steps in order: each step's next is the following one. */
function chain(steps: Array<Omit<WorkflowStep, "next">>): WorkflowStep[] {
  return steps.map((s, i) => (s.kind === "branch" || s.kind === "end" ? (s as WorkflowStep) : ({ ...s, next: steps[i + 1]?.key ?? null } as WorkflowStep)));
}

const sendStep = (key: string, m: MessageChoice): Omit<WorkflowStep, "next"> => ({
  key, kind: "send_message", name: "Send message", config: { templateId: m.templateId, contentHash: m.contentHash, channel: m.channel, sendAs: "sales_assistant", businessHoursOnly: true },
});

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "new_lead_welcome",
    name: "New lead: tag and welcome task",
    description: "When a contact is created, tag them and give their owner a task to welcome and qualify them within the hour.",
    trigger: "contact.created",
    sendsMessages: false,
    inputs: [{ key: "tag", label: "Tag for new leads", help: "Added to every new contact, so you can find them in Smart Lists.", kind: "tag", required: true }],
    build: (i) => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: chain([
        { key: "tag", kind: "add_tag", name: "Tag new lead", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
        { key: "task", kind: "create_task", name: "Welcome task", config: { title: "Welcome {{contact.full_name}} and qualify them", priority: "high", dueIn: { amount: 1, unit: "hours" }, assignee: "contact_owner" } },
      ]),
    }),
  },
  {
    key: "no_show_follow_up",
    name: "No-show follow-up",
    description: "When someone misses an appointment, their owner gets a follow-up task. Optionally, an approved message goes out first.",
    trigger: "appointment.no_show",
    sendsMessages: "optional",
    inputs: [{ key: "message", label: "Message to send (optional)", help: "An approved template, for example an offer to rebook.", kind: "message_template", required: false }],
    build: (i) => {
      const m = message(i.message);
      return {
        trigger: { type: "appointment.no_show" },
        steps: chain([
          ...(m ? [sendStep("message", m)] : []),
          { key: "task", kind: "create_task", name: "Follow-up task", config: { title: "Follow up with {{contact.full_name}}: missed appointment", priority: "high", dueIn: { amount: 2, unit: "hours" }, assignee: "contact_owner" } },
        ]),
      };
    },
  },
  {
    key: "won_deal_onboarding",
    name: "Won deal: start onboarding",
    description: "When a deal is won, create an onboarding task linked to the deal, and optionally tag the contact as a customer.",
    trigger: "opportunity.won",
    sendsMessages: false,
    inputs: [
      { key: "pipeline", label: "Pipeline (optional)", help: "Only deals won in this pipeline. Leave empty for every pipeline.", kind: "pipeline", required: false },
      { key: "owner", label: "Onboarding owner (optional)", help: "Who gets the task. Leave empty to give it to the contact's owner.", kind: "user", required: false },
      { key: "tag", label: "Customer tag (optional)", help: "Added to the contact when their deal is won.", kind: "tag", required: false },
    ],
    build: (i) => {
      const owner = str(i.owner);
      const tag = str(i.tag);
      return {
        trigger: { type: "opportunity.won", ...(str(i.pipeline) ? { filters: { pipelineId: str(i.pipeline)! } } : {}) },
        steps: chain([
          { key: "task", kind: "create_task", name: "Onboarding task", config: { title: "Start onboarding for {{contact.full_name}}", priority: "normal", dueIn: { amount: 1, unit: "days" }, assignee: owner ? "user" : "contact_owner", ...(owner ? { userId: owner } : {}), linkOpportunity: true } },
          ...(tag ? [{ key: "tag", kind: "add_tag" as const, name: "Tag as customer", config: { tagIds: [tag] } }] : []),
        ]),
      };
    },
  },
  {
    key: "booked_move_stage",
    name: "Booked appointment: move the deal",
    description: "When an appointment is booked, move the contact's open deal in a pipeline to a stage, such as \"Appointment set\".",
    trigger: "appointment.booked",
    sendsMessages: false,
    inputs: [{ key: "stage", label: "Move to stage", help: "The contact's open deal in this stage's pipeline moves here.", kind: "stage", required: true }],
    build: (i) => {
      const s = stage(i.stage);
      return {
        trigger: { type: "appointment.booked" },
        steps: chain([{ key: "move", kind: "move_stage", name: "Move deal", config: { pipelineId: s?.pipelineId ?? "", stageId: s?.stageId ?? "" } }]),
      };
    },
  },
  {
    key: "no_reply_nudge",
    name: "Message, then a task if there's no reply",
    description: "When a tag is added, send an approved message. If the contact hasn't replied two days later, their owner gets a task to call them.",
    trigger: "contact.tag_added",
    sendsMessages: true,
    inputs: [
      { key: "tag", label: "Starting tag", help: "Adding this tag to a contact starts the workflow.", kind: "tag", required: true },
      { key: "message", label: "Message to send", help: "An approved template.", kind: "message_template", required: true },
    ],
    build: (i) => {
      const m = message(i.message);
      return {
        trigger: { type: "contact.tag_added", filters: str(i.tag) ? { tagIds: [str(i.tag)!] } : {}, reentry: "not_while_active" },
        steps: [
          { ...sendStep("message", m ?? { templateId: "", contentHash: "", channel: "sms" }), next: "wait" },
          { key: "wait", kind: "wait", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, next: "replied" },
          { key: "replied", kind: "branch", name: "No reply yet?", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, branches: { yes: "task", no: null } },
          { key: "task", kind: "create_task", name: "Call task", config: { title: "No reply from {{contact.full_name}}: give them a call", priority: "high", dueIn: { amount: 4, unit: "hours" }, assignee: "contact_owner" }, next: null },
        ],
      };
    },
  },
];

export const workflowTemplate = (key: string) => WORKFLOW_TEMPLATES.find((t) => t.key === key) ?? null;
