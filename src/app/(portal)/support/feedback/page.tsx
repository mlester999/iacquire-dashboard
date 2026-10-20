import { SupportFormPage } from "@/components/support/form-page";

export const metadata = { title: "Provide Feedback" };

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ from?: string; category?: string }> }) {
  return <SupportFormPage kind="feedback" searchParams={await searchParams} />;
}
