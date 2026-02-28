export function normalizeChatIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("+") || lower.startsWith("joinchat/")) {
    return trimmed;
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  if (withoutProtocol.toLowerCase().startsWith("t.me/")) {
    const rest = withoutProtocol.slice("t.me/".length);
    const clean = rest.replace(/^\/+/, "");
    const cleanLower = clean.toLowerCase();

    if (cleanLower.startsWith("c/")) {
      const parts = clean.split(/[/?#]/)[0]?.split("/").filter(Boolean) ?? [];
      const chatId = parts[1] ?? "";
      if (/^\d+$/.test(chatId)) return `-100${chatId}`;
      return trimmed;
    }

    if (clean.startsWith("+") || cleanLower.startsWith("joinchat/")) {
      return trimmed;
    }

    const token = clean.split(/[/?#]/)[0] ?? "";
    if (!token) return trimmed;
    return token.startsWith("@") ? token : `@${token}`;
  }

  return trimmed;
}

export function parseTelegramInviteHash(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutDomain = withoutProtocol.toLowerCase().startsWith("t.me/")
    ? withoutProtocol.slice("t.me/".length)
    : withoutProtocol;

  const clean = withoutDomain.replace(/^\/+/, "");
  const cleanLower = clean.toLowerCase();

  let rest: string | null = null;
  if (clean.startsWith("+")) rest = clean.slice(1);
  else if (cleanLower.startsWith("joinchat/")) rest = clean.slice("joinchat/".length);
  if (rest == null) return null;

  const token = rest.split(/[/?#]/)[0]?.trim() ?? "";
  if (!token) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return null;
  return token;
}

export function buildCanonicalChannelIdentifier(
  resolved: { peerType: string; telegramId: bigint | null; username: string | null },
  fallback: string,
): string {
  const fallbackTrimmed = fallback.trim();

  if (resolved.peerType === "channel") {
    const username = typeof resolved.username === "string" ? resolved.username.trim().replace(/^@/, "") : "";
    if (username) return `@${username}`;
    if (typeof resolved.telegramId === "bigint" && resolved.telegramId > 0n) return `-100${resolved.telegramId.toString()}`;
    return fallbackTrimmed;
  }

  if (resolved.peerType === "user") {
    if (fallbackTrimmed.toLowerCase() === "me") return "me";
    const username = typeof resolved.username === "string" ? resolved.username.trim().replace(/^@/, "") : "";
    if (username) return `@${username}`;
    return fallbackTrimmed;
  }

  return fallbackTrimmed;
}

export function buildSourceMessageLink(
  source: { username?: string | null; telegramId?: bigint | null },
  messageId: number,
): string | null {
  const username = typeof source.username === "string" ? source.username.trim().replace(/^@/, "") : "";
  if (username) return `https://t.me/${username}/${messageId}`;
  const telegramId = source.telegramId;
  if (typeof telegramId === "bigint" && telegramId > 0n) return `https://t.me/c/${telegramId.toString()}/${messageId}`;
  return null;
}

export function formatOriginalLinkComment(sourceLink: string): string {
  return `原文链接：${sourceLink}`;
}

