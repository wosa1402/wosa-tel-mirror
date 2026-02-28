import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { loadEnv } from "@/lib/env";
import { cleanupExpiredSessions, loginSessions } from "@/lib/telegram-login";
import { requireApiAuth } from "@/lib/api-auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/utils";

loadEnv();

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH?.trim() ?? "";

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  cleanupExpiredSessions();

  const body = await request.json().catch(() => ({}));
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : "";

  const ip = getClientIp(request);
  const ipLimiter = checkRateLimit(`telegram:send_code:ip:${ip}`, { windowMs: 10 * 60 * 1000, max: 5 });
  if (!ipLimiter.allowed) {
    const res = NextResponse.json({ error: "Too many requests, please try again later" }, { status: 429 });
    res.headers.set("Retry-After", String(ipLimiter.retryAfterSec));
    return res;
  }

  if (phoneNumber) {
    const phoneHash = crypto.createHash("sha256").update(phoneNumber, "utf8").digest("hex").slice(0, 32);
    const phoneLimiter = checkRateLimit(`telegram:send_code:phone:${phoneHash}`, { windowMs: 10 * 60 * 1000, max: 3 });
    if (!phoneLimiter.allowed) {
      const res = NextResponse.json({ error: "Too many requests, please try again later" }, { status: 429 });
      res.headers.set("Retry-After", String(phoneLimiter.retryAfterSec));
      return res;
    }
  }

  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    return NextResponse.json(
      { error: "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables" },
      { status: 500 },
    );
  }

  if (!phoneNumber) {
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 });
  }

  try {
    const client = new TelegramClient(new StringSession(""), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 3 });
    await client.connect();

    const result = await client.sendCode({ apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH }, phoneNumber);

    const loginId = crypto.randomUUID();
    loginSessions.set(loginId, {
      client,
      phoneCodeHash: result.phoneCodeHash,
      phoneNumber,
      createdAt: Date.now(),
    });

    return NextResponse.json({ loginId });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
