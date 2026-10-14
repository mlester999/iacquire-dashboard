import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Isolated local visual QA must not overwrite the running application's build output.
  distDir: process.env.NODE_ENV !== "production" && process.env.IAQ_DIST_DIR?.startsWith(".next-") ? process.env.IAQ_DIST_DIR : process.env.IAQ_UI_QA === "true" && process.env.NODE_ENV !== "production" ? ".next-ui-qa" : ".next",
  poweredByHeader: false,
  // Lets local QA run an agency session on 127.0.0.1 next to a client session on localhost.
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  async redirects() {
    // The brief suggested /dashboard/setup; the portal's routes live at the top level.
    return [
      { source: "/dashboard/setup", destination: "/setup", permanent: false },
      { source: "/dashboard/add-ons", destination: "/add-ons", permanent: false },
      { source: "/dashboard/projects", destination: "/projects", permanent: false },
      { source: "/dashboard/projects/:path*", destination: "/projects/:path*", permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
