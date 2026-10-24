import { ApiFault, validate, type Envelope } from "./contracts.js";
import { safeDiagnostics, diagnosticFailureMessage } from "./diagnostics.js";

/** Role 5 transport: no automatic POST retries and no redirects to a different host. */
export class ContractClient {
  constructor(private base: string, private timeoutMs = 5000, private request: typeof fetch = fetch) {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Service URL must be HTTP(S)");
  }
  async call(path: string, responseSchema: string, requestId: string, body?: unknown, headers: Record<string, string> = {}): Promise<Envelope> {
    try {
      const response = await this.request(this.base.replace(/\/$/, "") + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...headers, "Content-Type": "application/json", "X-Request-ID": requestId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new ApiFault(502, "CONTRACT_VIOLATION", "Empty provider response");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8_000_000) throw new ApiFault(502, "CONTRACT_VIOLATION", "Provider response exceeds 8 MB");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new ApiFault(502, "CONTRACT_VIOLATION", "Provider returned invalid JSON"); }
      if (!response.ok) {
        validate("Error", value, true);
        if (value.request_id !== requestId) throw new ApiFault(502, "CONTRACT_VIOLATION", "Provider lost request ID");
        const diagnostics = value.error.diagnostics ? safeDiagnostics(value.error.diagnostics) : undefined;
        if (diagnostics && !diagnostics.issues.length) throw new ApiFault(502, "CONTRACT_VIOLATION", "Provider returned invalid diagnostics");
        throw new ApiFault([400, 403, 404, 409, 413, 415, 422, 429, 503, 504].includes(response.status) ? response.status : 502,
          value.error.code, diagnostics?.issues.length ? diagnosticFailureMessage(value.error.code, diagnostics) : value.error.message, diagnostics);
      }
      validate(responseSchema, value, true);
      if (value.meta.request_id !== requestId) throw new ApiFault(502, "CONTRACT_VIOLATION", "Provider lost request ID");
      return value as Envelope;
    } catch (error) {
      if (error instanceof ApiFault) throw error;
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new ApiFault(504, "DEPENDENCY_TIMEOUT", "Provider timeout");
      throw new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "Provider unavailable");
    }
  }
}
