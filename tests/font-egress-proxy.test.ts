import { describe, expect, it } from "vitest";
import { extractTlsClientHelloServerName, parseFontProxyTarget } from "../.github/scripts/font-egress-proxy.mjs";

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
});
