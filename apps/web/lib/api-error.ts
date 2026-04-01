import { getErrorMessage } from "@/lib/utils";

export function toErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}

export function getErrorCauseMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if (!("cause" in error)) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return null;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function toPublicErrorMessage(error: unknown, fallback = "服务器内部错误"): string {
  if (process.env.NODE_ENV === "production") return fallback;
  return toErrorMessage(error);
}
