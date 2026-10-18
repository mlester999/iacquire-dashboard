import type { Metadata } from "next";

// Public booking pages: no portal shell, no sign-in. Pages set their own titles (the business's name, not the portal's).
export const metadata: Metadata = {
  title: { default: "Book an appointment", template: "%s" },
  robots: { index: false, follow: false },
};

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-backdrop min-h-dvh">{children}</div>;
}
