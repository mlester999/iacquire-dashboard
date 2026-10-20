import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// Hosted production always uses Postgres. The embedded PGlite driver is a local-development
// fallback, but because it is a `serverExternalPackage` the static tracer copied 17.2 MB of
// WASM and data into every serverless function. That inflated each cold start. Exclude it from
// builds that cannot use it; a build explicitly configured for local PGlite keeps it.
const localPgliteBuild =
  process.env.AUTH_PROVIDER === "local" || process.env.DATABASE_DRIVER === "pglite" || process.env.DATABASE_DRIVER === "pglite-memory";

const nextConfig: NextConfig = {
  // Isolated local visual QA must not overwrite the running application's build output.
  distDir: process.env.IAQ_DIST_DIR?.startsWith(".next-") ? process.env.IAQ_DIST_DIR : process.env.IAQ_UI_QA === "true" && process.env.NODE_ENV !== "production" ? ".next-ui-qa" : ".next",
  poweredByHeader: false,
  // DATABASE_SSL_CA_FILE is read through an environment-derived filesystem path, so the static
  // tracer cannot discover it from fs.readFileSync. Keep the public root CA in every Node function.
  outputFileTracingIncludes: {
    "/*": ["./certs/prod-ca-2021.crt"],
  },
  ...(localPgliteBuild
    ? {}
    : {
        outputFileTracingExcludes: {
          "/*": ["./node_modules/@electric-sql/pglite/**/*"],
        },
      }),
  // Lets local QA run an agency session on 127.0.0.1 next to a client session on localhost.
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
    // The CRM browser matrix compiles many routes in one isolated dev process. Let Next restart
    // the dev worker at its memory threshold before the long sweep can exhaust the heap.
    ...(process.env.IAQ_DIST_DIR === ".next-crm-qa" && process.env.NODE_ENV === "development"
      ? { devMemoryThresholdRestart: true, webpackMemoryOptimizations: true }
      : {}),
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
    return [
      { source: "/:path*", headers: securityHeaders },
      // Website previews are drawn inside an iframe on a portal page (same origin only), which keeps a site's styles away from the editor.
      { source: "/frame/:path*", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/dev/frame/:path*", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/website-thumbnails/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // The starter photographs keep their file names when replaced, so they may be reused for a day and revalidated quietly for a week after that.
      { source: "/template-images/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      { source: "/template-images-sized/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
};

export default nextConfig;
