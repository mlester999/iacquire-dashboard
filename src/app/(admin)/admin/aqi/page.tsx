import { requireAgency } from "@/server/tenancy/context";
import { getAqiAdminData } from "@/server/aqi/service";
import { getAqiTutorialAdminData } from "@/server/aqi/tutorials";
import { listAqiKnowledgeDocuments, listAqiKnowledgeReview } from "@/server/aqi/knowledge-documents";
import { AqiAdmin } from "@/components/admin/aqi-admin";

export const metadata = { title: "AQi Management" };
export const dynamic = "force-dynamic";

export default async function AqiAdminPage() {
  await requireAgency("super_admin");
  const [data, tutorialData, documents, knowledgeReview] = await Promise.all([
    getAqiAdminData(),
    getAqiTutorialAdminData(),
    listAqiKnowledgeDocuments(),
    listAqiKnowledgeReview(),
  ]);
  return <AqiAdmin data={data} tutorialData={tutorialData} documents={documents} knowledgeReview={knowledgeReview} />;
}
