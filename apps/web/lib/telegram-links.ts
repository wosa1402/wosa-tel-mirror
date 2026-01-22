function toTelegramInternalId(telegramId: string | null | undefined): string | null {
  if (!telegramId) return null;
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
  telegramId: string | null | undefined;
  anchorMessageId?: number;
}): string | null {
  const uname = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (uname) return `https://t.me/${uname}`;

  const internalId = toTelegramInternalId(telegramId);
  if (!internalId) return null;

  const safeAnchor = Number.isFinite(anchorMessageId) && anchorMessageId > 0 ? Math.trunc(anchorMessageId) : 1;
  return `https://t.me/c/${internalId}/${safeAnchor}`;
}
