import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { db, parseSettingValue, schema } from "@tg-back/db";
import { decrypt } from "@/lib/crypto";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toInternalServerErrorResponse } from "@/lib/api-response";
import { getTelegramErrorMessage } from "@/lib/telegram-errors";

loadEnv();

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH?.trim() ?? "";

const PROXY_HOST = process.env.PROXY_HOST || process.env.WINDOWS_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT ? Number.parseInt(process.env.PROXY_PORT, 10) : 10808;

type TelegramChannelOption = {
  title: string;
  identifier: string;
  username: string | null;
  telegramId: string | null;
};

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
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables");
  }

  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, "telegram_session"))
    .limit(1);

  const encryptedSession = parseSettingValue("telegram_session", row?.value);
  const sessionString = decrypt(encryptedSession);
  if (!sessionString.trim()) {
    throw new Error("Telegram session 未配置，请先在首页完成 Telegram 登录");
  }

  const clientOptions: ConstructorParameters<typeof TelegramClient>[3] = { connectionRetries: 3 };
  if (PROXY_HOST) {
    clientOptions.proxy = {
      socksType: 5,
      ip: PROXY_HOST,
      port: Number.isFinite(PROXY_PORT) ? PROXY_PORT : 10808,
    } as unknown as ConstructorParameters<typeof TelegramClient>[3]["proxy"];
  }

  return new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, clientOptions);
}

export async function GET(request: NextRequest) {
  try {
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
      const telegramMsg = getTelegramErrorMessage(error);
      if (telegramMsg) return NextResponse.json({ error: telegramMsg }, { status: 400 });

      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Telegram session 未配置")) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }

      return toInternalServerErrorResponse(error, "加载 Telegram 对话列表失败");
    } finally {
      if (client) client.disconnect().catch(() => {});
    }
  } catch (error: unknown) {
    return toInternalServerErrorResponse(error, "加载 Telegram 对话列表失败");
  }
}
