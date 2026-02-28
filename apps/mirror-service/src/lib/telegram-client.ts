import { eq } from "drizzle-orm";
import { db, parseSettingValue, schema } from "@tg-back/db";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { decrypt } from "@tg-back/crypto";
import { sleep } from "../utils/sleep";
import { withDbRetry } from "./db-retry";
import { readStringProp } from "./object-props";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";

export type TelegramClientStartOptions = {
  floodWaitAutoSleepMaxSec: number;
  mirrorStartRetryIntervalSec: number;
  mirrorStartRetryIntervalMs: number;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export async function getTelegramClient(options: TelegramClientStartOptions): Promise<TelegramClient> {
  const apiIdRaw = requireEnv("TELEGRAM_API_ID");
  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error(`Invalid env TELEGRAM_API_ID: ${apiIdRaw}`);
  }
  const apiHash = requireEnv("TELEGRAM_API_HASH");

  const loadEncryptedSession = async (): Promise<string> => {
    const [row] = await withDbRetry(
      () =>
        db
          .select({ value: schema.settings.value })
          .from(schema.settings)
          .where(eq(schema.settings.key, "telegram_session"))
          .limit(1),
      "load telegram_session",
      { attempts: 5, baseDelayMs: 300 },
    );

    return parseSettingValue("telegram_session", row?.value);
  };

  const isSessionInvalidError = (error: unknown): boolean => {
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    if (!msg) return false;
    return msg.includes("AUTH_KEY_UNREGISTERED") || msg.includes("SESSION_REVOKED") || msg.includes("AUTH_KEY_INVALID");
  };

  const isFatalConfigError = (error: unknown): boolean => {
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    if (!msg) return false;
    return msg.includes("API_ID_INVALID") || msg.includes("API_ID_PUBLISHED_FLOOD") || msg.includes("APP_VERSION_INVALID");
  };

  const isTransientError = (error: unknown): boolean => {
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    if (!msg) return false;
    return (
      msg.includes("RPC_CALL_FAIL") ||
      msg.includes("TIMEOUT") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNRESET") ||
      msg.includes("EPIPE") ||
      msg.includes("CONNECTION_CLOSED") ||
      msg.includes("Connection closed") ||
      msg.includes("Network") ||
      msg.includes("network") ||
      msg.includes("socket") ||
      msg.includes("Socket")
    );
  };

  let lastMissingLogAt = 0;

  for (;;) {
    let encryptedSession = "";
    try {
      encryptedSession = await loadEncryptedSession();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[startup] failed to load telegram_session from DB; retrying in ${options.mirrorStartRetryIntervalSec}s: ${msg}`,
      );
      await sleep(options.mirrorStartRetryIntervalMs);
      continue;
    }

    let sessionString = "";
    try {
      sessionString = decrypt(encryptedSession);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Missing env ENCRYPTION_SECRET")) throw error;
      console.warn(
        `[startup] failed to decrypt telegram_session (maybe ENCRYPTION_SECRET changed or session is corrupt); retrying in ${options.mirrorStartRetryIntervalSec}s: ${msg}`,
      );
      await sleep(options.mirrorStartRetryIntervalMs);
      continue;
    }

    if (!sessionString.trim()) {
      const now = Date.now();
      if (now - lastMissingLogAt > 30_000) {
        lastMissingLogAt = now;
        console.warn(`[startup] 尚未登录 Telegram（settings.telegram_session 为空），请先打开 Web 首页完成登录...`);
      }
      await sleep(options.mirrorStartRetryIntervalMs);
      continue;
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
    });

    const connectDelaysMs = [0, 500, 1500, 3000, 5000];
    let lastError: unknown = null;

    for (const delayMs of connectDelaysMs) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        await client.connect();
        const me = await client.getMe();
        const usernameValue = readStringProp(me, "username");
        const firstNameValue = readStringProp(me, "firstName");
        const username = usernameValue ? `@${usernameValue}` : "";
        const firstName = firstNameValue ? firstNameValue : "";
        console.log(`mirror-service connected to Telegram as ${username || firstName || "unknown"}`);
        return client;
      } catch (error: unknown) {
        lastError = error;

        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
          await sleep((waitSeconds + 1) * 1000);
          continue;
        }

        if (isFatalConfigError(error)) {
          try {
            await client.disconnect();
          } catch {
            // ignore
          }
          const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          throw new Error(`Telegram config error: ${msg}`);
        }

        if (isSessionInvalidError(error)) {
          const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          console.warn(
            `[startup] Telegram session 已失效（${msg}），请在 Web 里重新登录；${options.mirrorStartRetryIntervalSec}s 后重试...`,
          );
          break;
        }

        if (isTransientError(error)) {
          const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          console.warn(`[startup] Telegram connection transient error, retrying: ${msg}`);
          continue;
        }

        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`[startup] Telegram connection failed: ${msg}`);
        break;
      }
    }

    try {
      await client.disconnect();
    } catch {
      // ignore
    }

    if (isFatalConfigError(lastError)) {
      const msg = getTelegramErrorMessage(lastError) ?? (lastError instanceof Error ? lastError.message : String(lastError));
      throw new Error(`Telegram config error: ${msg}`);
    }

    await sleep(options.mirrorStartRetryIntervalMs);
  }
}
