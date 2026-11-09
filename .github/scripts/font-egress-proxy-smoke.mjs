import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";

const proxyHost = "font-egress-proxy";
const proxyPort = 3128;

function u16(value) {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

function u24(value) {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function fakeClientHello(serverName) {
  const host = Buffer.from(serverName, "ascii");
  const serverNameEntry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const serverNameList = Buffer.concat([u16(serverNameEntry.length), serverNameEntry]);
  const serverNameExtension = Buffer.concat([u16(0), u16(serverNameList.length), serverNameList]);
  const extensions = Buffer.concat([serverNameExtension]);
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

function readUntilClose(socket, timeoutMs = 4000, tolerateReset = false) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the font proxy response"));
    }, timeoutMs);
    socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (tolerateReset) resolve(data.toString("latin1"));
      else reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(data.toString("latin1"));
    });
  });
}

async function rejectUnknownHost() {
  const socket = net.createConnection({ host: proxyHost, port: proxyPort });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const result = readUntilClose(socket);
  socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const response = await result;
  assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/);
}

async function rejectMismatchedTlsServerName() {
  const socket = net.createConnection({ host: proxyHost, port: proxyPort });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const closed = readUntilClose(socket, 4000, true);
  socket.write("CONNECT fonts.googleapis.com:443 HTTP/1.1\r\nHost: fonts.googleapis.com:443\r\n\r\n");
  let response = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for CONNECT acknowledgement")), 3000);
    const onData = (chunk) => {
      response += chunk.toString("latin1");
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 200 Connection Established\r\n/);
  socket.write(fakeClientHello("example.com"));
  await closed;
}

function verifyNoDefaultEgressRoute() {
  const rows = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  const hasDefaultRoute = rows.some((row) => {
    const columns = row.trim().split(/\s+/);
    return columns[1] === "00000000" && columns[7] === "00000000" && (Number.parseInt(columns[3], 16) & 1) === 1;
  });
  assert.equal(hasDefaultRoute, false, "the isolated build container must have no direct egress route");
}

await Promise.all([
  rejectUnknownHost(),
  rejectMismatchedTlsServerName(),
]);
verifyNoDefaultEgressRoute();
console.log("FONT_PROXY_SMOKE_PASS default_route=absent unknown_host=denied mismatched_sni=denied");
