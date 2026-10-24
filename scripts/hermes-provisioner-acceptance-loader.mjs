import { registerHooks } from "node:module";

// Direct route imports run outside the Next.js compiler. Preserve the server-only
// marker's server semantics while keeping React's default export for next/navigation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});