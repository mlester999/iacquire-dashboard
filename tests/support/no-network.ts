import net from "node:net";
import { afterEach } from "vitest";

/**
 * Tests never reach the internet. Every outbound socket connection to a host that is not this machine is refused, and the test that tried fails, even when the code
 * under test catches the error and turns it into "the provider is unavailable". fetch, https.request and tls all open their connection through
 * net.Socket.prototype.connect, so one guard covers them; a local server on 127.0.0.1 or ::1 (several tests start one), a named pipe and a unix socket are still allowed.
 *
 * Why: a provider adapter test that forgets to replace the HTTP layer would otherwise send a real request with a made-up key (one did, five times, to a payment
 * provider, answered 401). A test that wants to exercise a failure replaces fetch (vi.stubGlobal) and returns the failure itself.
 */
const blocked: string[] = [];
// Readable by the guard's own test, which has to clear the record it provokes.
(globalThis as { __noNetworkBlocked?: string[] }).__noNetworkBlocked = blocked;

const isLoopback = (host: unknown) => {
  const h = String(host ?? "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::" || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
};

type Lookup = (hostname: string, options: unknown, callback: (...r: unknown[]) => void) => void;
type Target = { path?: string; host?: unknown; port?: unknown; lookup?: Lookup };

function targetOf(args: unknown[]): Target {
  const first = args[0];
  // net.connect normalises its arguments and hands Socket.connect a single array [options, callback].
  const options = Array.isArray(first) ? first[0] : first;
  if (options && typeof options === "object") return options as Target;
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
  return { path: typeof first === "string" ? first : undefined };
}

const addressesOf = (found: unknown): string[] =>
  (Array.isArray(found) ? found.map((f) => (f && typeof f === "object" ? (f as { address?: unknown }).address : f)) : [found]).map(String);

/**
 * A name that comes with its own lookup (the pinned transport and its test do this) is allowed when the lookup answers with an address on this machine: the
 * answer is what the socket connects to, so that is what is checked. A lookup that answers with any other address fails the connection like an unreachable host.
 */
function withCheckedLookup(args: unknown[], lookup: Lookup, where: string): unknown[] {
  const checked: Lookup = (hostname, options, callback) =>
    lookup(hostname, options, (err: unknown, address: unknown, family: unknown) => {
      if (err) return callback(err, address, family);
      const elsewhere = addressesOf(address).filter((a) => !isLoopback(a));
      if (!elsewhere.length) return callback(null, address, family);
      blocked.push(`${where} -> ${elsewhere.join(", ")}`);
      callback(new Error(`Blocked: tests may not open a network connection (${where} resolved to ${elsewhere.join(", ")}). Replace the HTTP layer in the test instead of letting it reach the network.`));
    });
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const copy = { ...(options as object), lookup: checked };
  // Node marks the array net.connect hands over with a symbol property that tells Socket.connect the arguments are already normalised; Object.assign keeps it.
  const replaced = Array.isArray(first) ? Object.assign(first.slice(), first, { 0: copy }) : copy;
  return [replaced, ...args.slice(1)];
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const t = targetOf(args);
  if (!t.path && !isLoopback(t.host)) {
    const where = `${String(t.host)}:${String(t.port ?? "")}`;
    if (typeof t.lookup === "function" && typeof t.host === "string" && net.isIP(t.host) === 0) {
      return (original as (...a: unknown[]) => net.Socket).apply(this, withCheckedLookup(args, t.lookup, where));
    }
    blocked.push(where);
    // Fail the way an unreachable host fails: an error on the socket, so fetch rejects and https.request emits 'error' (a synchronous throw leaves fetch hanging).
    const error = new Error(`Blocked: tests may not open a network connection (${where}). Replace the HTTP layer in the test (for example vi.stubGlobal("fetch", ...)) instead of letting it reach the network.`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return (original as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

afterEach(() => {
  if (!blocked.length) return;
  const attempts = [...new Set(blocked)].join(", ");
  blocked.length = 0;
  throw new Error(`This test tried to reach the network (${attempts}). Tests must replace the HTTP layer; nothing was sent.`);
});
