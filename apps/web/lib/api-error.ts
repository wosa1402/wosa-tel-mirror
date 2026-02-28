import { getErrorMessage } from "@/lib/utils";

export function toErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}

export function toPublicErrorMessage(error: unknown, fallback = "服务器内部错误"): string {
  if (process.env.NODE_ENV === "production") return fallback;
  return toErrorMessage(error);
}
