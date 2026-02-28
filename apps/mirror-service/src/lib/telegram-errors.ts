export function getTelegramErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (!("errorMessage" in error)) return undefined;
  const maybe = (error as { errorMessage?: unknown }).errorMessage;
  return typeof maybe === "string" ? maybe : undefined;
}

export function parseFloodWaitSeconds(error: unknown): number | null {
  const msg =
    typeof error === "string" ? error : getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : "");
  if (!msg) return null;
  const m1 = msg.match(/FLOOD_WAIT_(\d+)/);
  if (m1) return Number.parseInt(m1[1] ?? "", 10);
  const m2 = msg.match(/A wait of (\d+) seconds is required/i);
  if (m2) return Number.parseInt(m2[1] ?? "", 10);
  return null;
}

export function isRetryableCommentThreadError(error: unknown): boolean {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : "");
  if (!msg) return false;
  return (
    msg.includes("MSG_ID_INVALID") ||
    msg.includes("MESSAGE_ID_INVALID") ||
    msg.includes("REPLY_MESSAGE_ID_INVALID") ||
    msg.includes("CHAT_ID_INVALID") ||
    msg.includes("CHANNEL_INVALID") ||
    msg.includes("PEER_ID_INVALID")
  );
}

