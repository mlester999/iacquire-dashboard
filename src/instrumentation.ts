// Keep Node-only database dependencies out of the Edge instrumentation bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}