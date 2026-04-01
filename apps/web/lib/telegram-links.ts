function toTelegramInternalId(telegramId: unknown): string | null {
  if (telegramId == null) return null;
  const raw = String(telegramId).trim();
  if (!raw) return null;

  const prefixed = raw.match(/^-100(\d+)$/);
  if (prefixed) return prefixed[1];

  return /^\d+$/.test(raw) ? raw : null;
}

export function buildTelegramChannelLink({
  username,
  telegramId,
  anchorMessageId = 1,
}: {
  username: string | null | undefined;
  telegramId: unknown;
  anchorMessageId?: number;
}): string | null {
  const uname = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (uname) return `https://t.me/${uname}`;

  const internalId = toTelegramInternalId(telegramId);
  if (!internalId) return null;

  const safeAnchor = Number.isFinite(anchorMessageId) && anchorMessageId > 0 ? Math.trunc(anchorMessageId) : 1;
  return `https://t.me/c/${internalId}/${safeAnchor}`;
}

export function buildTelegramMessageLink(
  channel: { username?: string | null | undefined; telegramId?: unknown },
  messageId: number | null | undefined,
): string | null {
  const safeMessageId = typeof messageId === "number" && Number.isFinite(messageId) && messageId > 0 ? Math.trunc(messageId) : null;
  if (!safeMessageId) return null;

  const uname = typeof channel.username === "string" ? channel.username.trim().replace(/^@/, "") : "";
  if (uname) return `https://t.me/${uname}/${safeMessageId}`;

  const internalId = toTelegramInternalId(channel.telegramId);
  if (!internalId) return null;

  return `https://t.me/c/${internalId}/${safeMessageId}`;
}
