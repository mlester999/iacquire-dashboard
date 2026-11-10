import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const APPROVED_FONT_HOSTS = Object.freeze([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

const allowedHosts = new Set(APPROVED_FONT_HOSTS);
const MAX_CLIENT_HELLO_BYTES = 16 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

/** Accept only HTTPS CONNECT targets for the two owner-approved font hosts. */
export function parseFontProxyTarget(authorityOrUrl) {
  if (typeof authorityOrUrl !== "string" || !authorityOrUrl || /[\u0000-\u0020\u007f]/.test(authorityOrUrl)) return null;

  let target;
  try {
    target = new URL(authorityOrUrl.includes("://") ? authorityOrUrl : `https://${authorityOrUrl}`);
  } catch {
    return null;
  }

  const host = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || target.username || target.password) return null;
  if (target.port && target.port !== "443") return null;
  if (target.pathname !== "/" || target.search || target.hash) return null;
  if (!allowedHosts.has(host)) return null;
  return { host, port: 443 };
}

/**
 * Extract the SNI hostname from one complete TLS ClientHello record.
 * Returns undefined for an incomplete record, null for malformed/no-SNI data.
 * Fragmented or oversized ClientHello messages fail closed in the proxy.
 */
export function extractTlsClientHelloServerName(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 5) return undefined;
  if (buffer[0] !== 0x16) return null;

  const recordLength = buffer.readUInt16BE(3);
  if (recordLength > MAX_CLIENT_HELLO_BYTES) return null;
  if (buffer.length < 5 + recordLength) return undefined;
  const recordEnd = 5 + recordLength;

  let offset = 5;
  if (offset + 4 > recordEnd || buffer[offset] !== 0x01) return null;
  const handshakeLength = buffer.readUIntBE(offset + 1, 3);
  offset += 4;
  if (offset + handshakeLength > recordEnd) return null;
  const helloEnd = offset + handshakeLength;
  if (offset + 34 > helloEnd) return null;

  // Legacy version (2) and random (32).
  offset += 34;
  if (offset + 1 > helloEnd) return null;
  const sessionIdLength = buffer[offset++];
  if (offset + sessionIdLength + 2 > helloEnd) return null;
  offset += sessionIdLength;

  const cipherLength = buffer.readUInt16BE(offset);
  offset += 2;
  if (offset + cipherLength + 1 > helloEnd) return null;
  offset += cipherLength;

  const compressionLength = buffer[offset++];
  if (offset + compressionLength + 2 > helloEnd) return null;
  offset += compressionLength;

  const extensionsLength = buffer.readUInt16BE(offset);
  offset += 2;
  if (offset + extensionsLength > helloEnd) return null;
  const extensionsEnd = offset + extensionsLength;
  const serverNames = [];

  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    const end = offset + length;
    if (end > extensionsEnd) return null;

    // ECH can hide an inner SNI. The approved Next font client does not need it.
    if (type === 0xfe0d) return null;
    if (type === 0x0000) {
      if (offset + 2 > end) return null;
      const listLength = buffer.readUInt16BE(offset);
      let nameOffset = offset + 2;
      const listEnd = nameOffset + listLength;
      if (listEnd !== end) return null;
      while (nameOffset + 3 <= listEnd) {
        const nameType = buffer[nameOffset++];
        const nameLength = buffer.readUInt16BE(nameOffset);
        nameOffset += 2;
        if (nameOffset + nameLength > listEnd) return null;
        if (nameType === 0) {
          const name = buffer.toString("ascii", nameOffset, nameOffset + nameLength).toLowerCase();
          if (!/^[a-z0-9.-]+$/.test(name)) return null;
          serverNames.push(name);
        }
        nameOffset += nameLength;
      }
      if (nameOffset !== listEnd) return null;
    }
    offset = end;
  }

  if (offset !== extensionsEnd || serverNames.length !== 1) return null;
  return serverNames[0];
}

const safeLabel = (value) => String(value).replace(/[^a-zA-Z0-9.:_-]/g, "?").slice(0, 180);

export function createFontEgressProxy({ logger = (line) => console.log(line), connectUpstream = net.connect } = {}) {
  const server = http.createServer((request, response) => {
    logger(`FONT_EGRESS_DENY_METHOD ${safeLabel(request.method)}`);
    response.writeHead(403, { connection: "close", "content-length": "0" }).end();
  });

  server.on("connect", (request, client, head) => {
    const target = parseFontProxyTarget(request.url ?? "");
    if (!target) {
      logger(`FONT_EGRESS_DENY_TARGET ${safeLabel(request.url ?? "")}`);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: iAcquire-Font-Allowlist\r\n\r\n");
    let pending = Buffer.alloc(0);
    let upstream = null;
    let connecting = false;
    let done = false;

    const deny = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      logger(`FONT_EGRESS_DENY_SNI ${target.host} ${reason}`);
      client.destroy();
      upstream?.destroy();
    };

    const timeout = setTimeout(() => deny("timeout"), CLIENT_HELLO_TIMEOUT_MS);
    const closeTunnel = () => {
      clearTimeout(timeout);
      if (!done) {
        // Closing the client intentionally tears down the upstream tunnel too.
        // Mark it complete first so the resulting socket error is not mistaken
        // for a failed font fetch.
        done = true;
        upstream?.destroy();
      }
    };
    client.on("error", closeTunnel);
    client.on("close", closeTunnel);

    const onClientData = (chunk) => {
      if (done) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_CLIENT_HELLO_BYTES) {
        deny("oversized-client-hello");
        return;
      }
      if (connecting) return;

      const serverName = extractTlsClientHelloServerName(pending);
      if (serverName === undefined) return;
      if (!serverName || serverName !== target.host || !allowedHosts.has(serverName)) {
        deny(`sni=${safeLabel(serverName ?? "missing-or-invalid")}`);
        return;
      }

      connecting = true;
      // A trailing dot makes this an absolute DNS name and avoids resolver search suffixes.
      upstream = connectUpstream({ host: `${target.host}.`, port: target.port });
      upstream.setTimeout(CLIENT_HELLO_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
      upstream.once("connect", () => {
        if (done) return;
        clearTimeout(timeout);
        logger(`FONT_EGRESS_ALLOW ${target.host}`);
        upstream.setTimeout(0);
        upstream.write(pending);
        pending = Buffer.alloc(0);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        logger(`FONT_EGRESS_UPSTREAM_ERROR ${target.host}`);
        client.destroy();
      });
    };

    client.on("data", onClientData);
    client.on("end", () => {
      if (!connecting) deny("client-ended-before-client-hello");
    });
    if (head.length) onClientData(head);
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3128);
  const proxy = createFontEgressProxy();
  proxy.listen(port, "0.0.0.0", () => {
    console.log(`FONT_PROXY_READY hosts=${APPROVED_FONT_HOSTS.join(",")} port=${port}`);
  });
}
