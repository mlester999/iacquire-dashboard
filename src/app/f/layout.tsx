import type { Metadata } from "next";

// Hosted form pages: no portal shell, no sign-in. Pages set their own titles (the business's and the form's, not the portal's).
export const metadata: Metadata = {
  title: { default: "Form", template: "%s" },
  robots: { index: false, follow: false },
};

export default function FormLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-backdrop min-h-dvh">{children}</div>;
}
