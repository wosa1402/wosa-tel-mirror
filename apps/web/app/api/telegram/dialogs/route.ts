import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { db, schema } from "@tg-back/db";
import { decrypt } from "@/lib/crypto";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

type TelegramChannelOption = {
  title: string;
  identifier: string;
  username: string | null;
  telegramId: string | null;
};

function getTelegramErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (!("errorMessage" in error)) return undefined;
  const maybe = (error as { errorMessage?: unknown }).errorMessage;
  return typeof maybe === "string" ? maybe : undefined;
}

function toPositiveIntString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "bigint") {
    const str = value.toString();
    if (!str || str === "0" || str.startsWith("-")) return null;
    return str;
  }
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? String(Math.trunc(value)) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "object" && "toString" in value) {
    const str = String((value as { toString: () => string }).toString()).trim();
    if (!str || str === "[object Object]") return null;
    return /^\d+$/.test(str) ? str : null;
  }
  return null;
}

function buildChannelIdentifier(username: unknown, telegramId: string | null): string | null {
  const uname = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (uname) return `@${uname}`;
  if (telegramId) return `-100${telegramId}`;
  return null;
}

async function createTelegramClientFromDbSession(): Promise<TelegramClient> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? "";

  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables");
  }

  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, "telegram_session"))
    .limit(1);

  const raw = row?.value;
  const encryptedSession = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const sessionString = decrypt(encryptedSession);
  if (!sessionString.trim()) {
    throw new Error("Telegram session 未配置，请先在首页完成 Telegram 登录");
  }

  const proxyHost = process.env.PROXY_HOST || process.env.WINDOWS_HOST;
  const proxyPort = process.env.PROXY_PORT ? Number.parseInt(process.env.PROXY_PORT, 10) : 10808;
  const clientOptions: ConstructorParameters<typeof TelegramClient>[3] = { connectionRetries: 3 };
  if (proxyHost) {
    clientOptions.proxy = {
      socksType: 5,
      ip: proxyHost,
      port: Number.isFinite(proxyPort) ? proxyPort : 10808,
    } as unknown as ConstructorParameters<typeof TelegramClient>[3]["proxy"];
  }

  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, clientOptions);
}

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
  const limit = Number.isFinite(limitParsed) ? Math.min(500, Math.max(1, limitParsed)) : 200;

  let client: TelegramClient | null = null;
  try {
    client = await createTelegramClientFromDbSession();
    await client.connect();

    const dialogs = await client.getDialogs({ limit });
    const channels: TelegramChannelOption[] = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Channel)) continue;
      if (!entity.broadcast) continue;

      const telegramId = toPositiveIntString(entity.id);
      const identifier = buildChannelIdentifier(entity.username, telegramId);
      if (!identifier) continue;

      const title = typeof entity.title === "string" && entity.title.trim() ? entity.title.trim() : identifier;
      const username =
        typeof entity.username === "string" && entity.username.trim()
          ? `@${entity.username.trim().replace(/^@/, "")}`
          : null;

      channels.push({ title, identifier, username, telegramId });
    }

    channels.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    return NextResponse.json({ channels });
  } catch (error: unknown) {
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: msg || "Failed to load Telegram dialogs" }, { status: 400 });
  } finally {
    if (client) client.disconnect().catch(() => {});
  }
}
