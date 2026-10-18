export function exitCodeFor(totals: Record<string, number>, fatal: string | null): number;
export function isLocalUrl(raw: string, base?: string): boolean;
export function isDevRestartInterruption(bucket: { pageErrors?: string[]; failedRequests?: Array<{ url?: string; error?: string }> } | null | undefined, navigationError?: string): boolean;
export function clearDevRestartNoise(bucket: { pageErrors?: string[]; consoleErrors?: string[]; failedRequests?: Array<{ url?: string; error?: string }>; aborted?: number } | null | undefined, options?: { clearConnections?: boolean }): void;
