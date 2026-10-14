import Link from "next/link";
import { AuthHeading, RequestAccessForm } from "@/components/auth/forms";

export const metadata = { title: "Get started" };

export default function GetStartedPage() {
  return (
    <>
      <AuthHeading
        eyebrow="Get started"
        title="Bring an AI team to your business"
        description={
          <>
            Tell us a little about your company. The iAcquire team reviews every request and sets up your dedicated workspace. Setup is a one-time{" "}
            <span className="font-medium text-ink">$1,499</span>.
          </>
        }
      />
      <RequestAccessForm />
      <p className="mt-6 text-center text-[13.5px] text-muted">
        Already a client?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
