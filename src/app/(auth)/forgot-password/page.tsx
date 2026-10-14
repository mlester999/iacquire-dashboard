import { AuthHeading, ForgotPasswordForm } from "@/components/auth/forms";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeading title="Forgot your password?" description="Enter your email and we'll send you a secure link to choose a new one." />
      <ForgotPasswordForm />
    </>
  );
}
