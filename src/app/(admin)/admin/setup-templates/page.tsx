import { requireAgency } from "@/server/tenancy/context";
import { listSetupTemplates } from "@/server/setup/templates";
import { SetupTemplateEditor } from "@/components/admin/setup/template-editor";

export const metadata = { title: "Master setup templates" };
export default async function TemplatePage() {
  const user = await requireAgency("super_admin");
  return <SetupTemplateEditor templates={await listSetupTemplates(user)} />;
}
