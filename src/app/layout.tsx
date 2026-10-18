import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  title: { default: "iAcquire Client Portal", template: "%s · iAcquire" },
  description: "Manage leads, appointments, sales and customer relationships with a team of AI employees built around your business.",
  robots: { index: false, follow: false },
  icons: { icon: "/brand/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#07080c" },
  ],
};

// Applies the saved theme before first paint to avoid a flash. Light is the default.
const themeScript = `(function(){try{var t=localStorage.getItem('iaq-theme');var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce issued by src/proxy.ts.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // The portal host is public configuration, not a secret. The AQi shell uses it to stay hidden on
  // customer website hosts that are rendered by this same root layout.
  let appHost = "";
  try {
    appHost = process.env.APP_URL ? new URL(process.env.APP_URL).host : "";
  } catch {
    appHost = "";
  }
  return (
    <html lang="en" suppressHydrationWarning data-app-host={appHost} className={`${geist.variable} ${geistMono.variable} ${instrument.variable}`}>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
