export const APPROVED_FONT_HOSTS: readonly ["fonts.googleapis.com", "fonts.gstatic.com"];
export function parseFontProxyTarget(authorityOrUrl: string): { host: string; port: 443 } | null;
export function extractTlsClientHelloServerName(buffer: Buffer | Uint8Array): string | null | undefined;
export function createFontEgressProxy(options?: { logger?: (line: string) => void }): import("node:http").Server;
