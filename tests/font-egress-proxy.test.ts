import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";
import { createFontEgressProxy, extractTlsClientHelloServerName, parseFontProxyTarget } from "../.github/scripts/font-egress-proxy.mjs";

function u16(value: number) {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

function u24(value: number) {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function clientHello(serverName: string, extraExtensions = Buffer.alloc(0)) {
  const host = Buffer.from(serverName, "ascii");
  const serverNameEntry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const serverNameList = Buffer.concat([u16(serverNameEntry.length), serverNameEntry]);
  const serverNameExtension = Buffer.concat([u16(0), u16(serverNameList.length), serverNameList]);
  const extensions = Buffer.concat([serverNameExtension, extraExtensions]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([Buffer.from([1]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

describe("build font egress allowlist", () => {
  it("runs Next directly in the internal build network without npm update traffic", () => {
    const workflow = readFileSync(".github/workflows/hermes-inference-worker.yml", "utf8");
    expect(workflow).toContain("docker network create --driver bridge --internal");
    expect(workflow).toContain("--env npm_config_update_notifier=false");
    expect(workflow).toContain('--workdir /workspace --entrypoint node "$node_image" /workspace/node_modules/next/dist/bin/next build');
    expect(workflow).not.toContain("registry.npmjs.org");
    expect(workflow).not.toContain("production build gated");
  });

  it("accepts HTTPS only for the two exact approved hosts on port 443", () => {
    expect(parseFontProxyTarget("fonts.googleapis.com:443")).toEqual({ host: "fonts.googleapis.com", port: 443 });
    expect(parseFontProxyTarget("fonts.gstatic.com:443")).toEqual({ host: "fonts.gstatic.com", port: 443 });
  });

  it.each([
    "example.com:443",
    "fonts.googleapis.com.evil:443",
    "sub.fonts.googleapis.com:443",
    "fonts.googleapis.com:444",
    "fonts.googleapis.com:80",
    "fonts.googleapis.com.:443",
    "user@fonts.googleapis.com:443",
    "http://fonts.googleapis.com:443",
    "https://fonts.gstatic.com:443/not-a-connect-authority",
  ])("rejects a destination outside the exact HTTPS host rule: %s", (target) => {
    expect(parseFontProxyTarget(target)).toBeNull();
  });

  it("extracts the exact TLS SNI and fails closed on incomplete or malformed data", () => {
    const hello = clientHello("fonts.gstatic.com");
    expect(extractTlsClientHelloServerName(hello)).toBe("fonts.gstatic.com");
    expect(extractTlsClientHelloServerName(hello.subarray(0, 3))).toBeUndefined();
    expect(extractTlsClientHelloServerName(Buffer.from("not tls"))).toBeNull();
    expect(extractTlsClientHelloServerName(clientHello("fonts.gstatic.com", Buffer.from([0xfe, 0x0d, 0, 0])))).toBeNull();
  });

  it("does not report an upstream error caused by downstream tunnel teardown", async () => {
    const logs: string[] = [];
    const proxySockets = new Set<net.Socket>();
    let markUpstreamConnected!: () => void;
    const upstreamConnected = new Promise<void>((resolve) => { markUpstreamConnected = resolve; });
    const connectUpstream = () => {
      const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) { callback(); },
      }) as Duplex & { setTimeout(msecs: number, callback?: () => void): unknown };
      socket.setTimeout = () => socket;
      socket.destroy = ((error?: Error) => {
        if (!error && !socket.destroyed) {
          process.nextTick(() => socket.emit("error", Object.assign(new Error("socket closed"), { code: "ECONNRESET" })));
        }
        return Duplex.prototype.destroy.call(socket, error);
      }) as typeof socket.destroy;
      process.nextTick(() => {
        socket.emit("connect");
        markUpstreamConnected();
      });
      return socket;
    };
    const proxy = createFontEgressProxy({ logger: (line) => logs.push(line), connectUpstream });
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });

    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy address");
    let client: net.Socket | null = null;

    try {
      client = net.connect(address.port, "127.0.0.1");
      await once(client, "connect");
      const response = new Promise<void>((resolve, reject) => {
        let data = "";
        const timer = setTimeout(() => reject(new Error("Timed out waiting for CONNECT response")), 3000);
        client!.on("data", (chunk) => {
          data += chunk.toString("latin1");
          if (!data.includes("\r\n\r\n")) return;
          clearTimeout(timer);
          expect(data).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n/);
          resolve();
        });
      });
      client.write("CONNECT fonts.googleapis.com:443 HTTP/1.1\r\nHost: fonts.googleapis.com:443\r\n\r\n");
      await response;
      client.write(clientHello("fonts.googleapis.com"));
      await upstreamConnected;

      client.destroy();
      await once(client, "close");
      await new Promise<void>((done) => setImmediate(done));
      expect(logs).toContain("FONT_EGRESS_ALLOW fonts.googleapis.com");
      expect(logs).not.toContain("FONT_EGRESS_UPSTREAM_ERROR fonts.googleapis.com");
    } finally {
      client?.destroy();
      for (const socket of proxySockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((done, reject) => proxy.close((error) => error ? reject(error) : done()));
    }
  }, 10_000);

  it("keeps an upstream connection failure observable", () => {
    const source = readFileSync(".github/scripts/font-egress-proxy.mjs", "utf8");
    expect(source).toMatch(/upstream\.once\("error", \(\) => \{\s*if \(done\) return;\s*done = true;\s*clearTimeout\(timeout\);\s*logger\(`FONT_EGRESS_UPSTREAM_ERROR/);
  });
});
