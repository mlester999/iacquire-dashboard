import { describe, expect, it, vi } from "vitest";
import { logSafeServerDiagnostic, OperationFailure, safeDiagnosticFields } from "@/server/diagnostics";

describe("safe server diagnostics", () => {
  it("keeps operation and underlying error codes while omitting messages and identifying data", () => {
    const privateDetails = "password=hunter2 email=person@example.com path=C:\\Users\\private\\cert.pem";
    const root = Object.assign(new Error(privateDetails), { code: "ENOENT", syscall: "open", path: privateDetails });
    const error = new OperationFailure(
      "auth.rate_limit_ip",
      new OperationFailure("database.read_tls_ca_file", root),
    );

    expect(safeDiagnosticFields(error, "auth.sign_in")).toEqual({
      operation: "auth.rate_limit_ip",
      dependencyOperation: "database.read_tls_ca_file",
      errorType: "Error",
      errorCode: "ENOENT",
      syscall: "open",
    });
    expect(JSON.stringify(safeDiagnosticFields(error, "auth.sign_in"))).not.toContain(privateDetails);
  });

  it("logs only safe fields", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = Object.assign(new Error("secret user input"), { code: "28P01" });
    logSafeServerDiagnostic("login action failed", new OperationFailure("database.postgres_query", cause), "auth.sign_in");

    expect(log).toHaveBeenCalledWith("[iacquire] login action failed", {
      operation: "database.postgres_query",
      errorType: "Error",
      errorCode: "28P01",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret user input");
    log.mockRestore();
  });
});
