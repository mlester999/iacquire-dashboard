import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getForm, getFormBuilderOptions, listFormVersions, type FormDetail } from "@/server/crm/forms/definitions";
import { listFormSubmissions, SUBMISSION_STATUSES, type SubmissionStatus } from "@/server/crm/forms/submissions";
import { FormEditor } from "@/components/crm/forms/form-editor";
import { FORM_TABS, type FormTab } from "@/components/crm/forms/types";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** One form's builder, settings, submissions and versions. Submissions load only on their tab, for people who may see contacts. */
export async function FormView({ actor, scope, id, searchParams = {} }: { actor: CrmActor; scope: CrmScope; id: string; searchParams?: SP }) {
  if (!UUID.test(id)) notFound();
  let form: FormDetail;
  try {
    form = await getForm(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const tabParam = one(searchParams.tab) ?? "build";
  const tab: FormTab = (FORM_TABS as readonly string[]).includes(tabParam) ? (tabParam as FormTab) : "build";
  const statusParam = one(searchParams.status);
  const status: SubmissionStatus | "all" = statusParam && (SUBMISSION_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as SubmissionStatus) : "all";
  const page = Math.max(1, Math.floor(Number(one(searchParams.page)) || 1));
  const canSeeSubmissions = actor.can("contacts.view");
  const [options, versions, submissions] = await Promise.all([
    getFormBuilderOptions(actor),
    listFormVersions(actor, id),
    tab === "submissions" && canSeeSubmissions ? listFormSubmissions(actor, { formId: id, status, page }) : Promise.resolve(null),
  ]);
  await auditSupportView(actor, "forms", id);
  return (
    <FormEditor
      scope={scope}
      form={JSON.parse(JSON.stringify(form))}
      options={JSON.parse(JSON.stringify(options))}
      versions={versions}
      tab={tab}
      submissions={submissions ? JSON.parse(JSON.stringify(submissions)) : null}
      submissionStatus={status}
      canManage={actor.can("forms.manage") && !scope.readOnly}
      canSeeSubmissions={canSeeSubmissions}
    />
  );
}
