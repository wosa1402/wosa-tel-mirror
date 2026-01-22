import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { loadEnv } from "@/lib/env";
import { cleanupExpiredSessions, loginSessions } from "@/lib/telegram-login";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "errorMessage" in error) {
    const maybeErrorMessage = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof maybeErrorMessage === "string") return maybeErrorMessage;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  cleanupExpiredSessions();

  const body = await request.json().catch(() => ({}));
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : "";

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? "";

  if (!apiId || !apiHash) {
    return NextResponse.json(
      { error: "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables" },
      { status: 500 },
    );
  }

  if (!phoneNumber) {
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 });
  }

  try {
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();

    const result = await client.sendCode({ apiId, apiHash }, phoneNumber);

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
