import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers, type AqiMode } from "@/components/providers";
import { getCurrentUser } from "@/server/auth/session";
import { routeRequest, type DeploymentRole } from "@/lib/site-routing";
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
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  const deploymentRole = (["portal", "sites", "both"].includes(process.env.DEPLOYMENT_ROLE ?? "")
    ? process.env.DEPLOYMENT_ROLE
    : "portal") as DeploymentRole;
  let appHost = "";
  try {
    appHost = new URL(process.env.APP_URL ?? "http://localhost:3000").hostname;
  } catch {
    appHost = "";
  }
  // Match the proxy's routing decision exactly: portal-only deployments accept any hostname,
  // while a combined portal/sites deployment only exposes AQi on a portal host.
  const aqiAllowed = routeRequest({
    role: deploymentRole,
    hostHeader: requestHeaders.get("host"),
    pathname: "/",
    portalHosts: [appHost],
  }).kind === "portal";
  // The role decides which AQi is drawn. getCurrentUser is cached per request, so the pages and layouts
  // that need the user anyway do not pay for this a second time; anonymous visitors cost a cookie check.
  let aqiMode: AqiMode = "assistant";
  if (aqiAllowed) {
    try {
      if ((await getCurrentUser())?.platformRole === "agency_super_admin") aqiMode = "operations";
    } catch {
      // The Client assistant is the safe default when the session cannot be read.
    }
  }
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable} ${instrument.variable}`}>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers aqiAllowed={aqiAllowed} aqiMode={aqiMode}>{children}</Providers>
      </body>
    </html>
  );
}
