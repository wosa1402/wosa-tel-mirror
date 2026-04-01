export function getTelegramErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (!("errorMessage" in error)) return undefined;
  const maybeErrorMessage = (error as { errorMessage?: unknown }).errorMessage;
  return typeof maybeErrorMessage === "string" ? maybeErrorMessage : undefined;
}

