import { SupportFormPage } from "@/components/support/form-page";

export const metadata = { title: "Request a Change" };

export default async function RequestChangePage({ searchParams }: { searchParams: Promise<{ from?: string; category?: string; project?: string }> }) {
  return <SupportFormPage kind="change" searchParams={await searchParams} />;
}
