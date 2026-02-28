import { sleep } from "../utils/sleep";

export function getDbErrorMeta(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const maybe = error as Record<string, unknown>;
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(`${label}=${value}`);
  };
  add("code", maybe.code);
  add("severity", maybe.severity);
  add("constraint", maybe.constraint);
  add("detail", maybe.detail);
  add("table", maybe.table);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function getDbErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const maybe = error as Record<string, unknown>;
  if (typeof maybe.code === "string" && maybe.code.trim()) return maybe.code.trim();
  if ("cause" in maybe) return getDbErrorCode(maybe.cause);
  return null;
}

function isDbConnectionError(error: unknown): boolean {
  const code = getDbErrorCode(error);
  if (code) {
    const normalized = code.toUpperCase();
    if (normalized.startsWith("08")) return true; // SQLSTATE: connection exception
    if (normalized === "CONNECTION_CLOSED") return true;
    if (normalized === "ECONNRESET") return true;
    if (normalized === "ETIMEDOUT") return true;
    if (normalized === "EPIPE") return true;
    if (normalized === "ECONNREFUSED") return true;
    if (normalized === "57P01") return true; // admin shutdown
    if (normalized === "57P02") return true; // crash shutdown
    if (normalized === "57P03") return true; // cannot connect now
    if (normalized === "53300") return true; // too many connections
  }

  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("Connection terminated unexpectedly") ||
    msg.includes("server closed the connection unexpectedly") ||
    msg.includes("terminating connection due to administrator command") ||
    msg.includes("remaining connection slots are reserved") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EPIPE") ||
    msg.includes("ECONNREFUSED")
  );
}

export async function withDbRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options?: { attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 3));
  const baseDelayMs = Math.max(50, Math.floor(options?.baseDelayMs ?? 250));

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (!isDbConnectionError(error) || attempt === attempts) throw error;
      const jitter = Math.floor(Math.random() * Math.min(1000, baseDelayMs));
      const delay = Math.min(5_000, baseDelayMs * attempt * attempt + jitter);
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`db connection error, retrying (${context}) in ${delay}ms: ${msg}`);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

