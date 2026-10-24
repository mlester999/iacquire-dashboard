import "server-only";
import { AppError } from "@/server/errors";

export function provisionerErrorResponse(error: unknown) {
  if (error instanceof AppError) {
    const status = error.code === "forbidden" ? 403
      : error.code === "not_found" ? 404
        : error.code === "conflict" ? 409
          : error.code === "invalid_input" ? 400
            : 503;
    return { status, body: { error: error.message } };
  }
  return { status: 500, body: { error: "The restricted provisioning request failed." } };
}

export async function readProvisionerJson(req: Request, maxBytes: number): Promise<unknown> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new AppError("invalid_input", "The provisioner request is too large.");
  if (!req.body) throw new AppError("invalid_input", "A JSON request body is required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError("invalid_input", "The provisioner request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new AppError("invalid_input", "The provisioner request must contain valid JSON.");
  }
}

export function provisionerAuthorized(req: Request, token: string | undefined, matches: (given: string | null, expected: string | undefined) => boolean) {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return matches(match?.[1] ?? null, token);
}
