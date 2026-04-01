import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@tg-back/db";
import { schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toInternalServerErrorResponse } from "@/lib/api-response";

loadEnv();

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, "telegram_session"));

    const value = row?.value;
    const sessionString = typeof value === "string" ? value : value == null ? "" : String(value);
    const isLoggedIn = sessionString.trim().length > 0;

    return NextResponse.json({ isLoggedIn });
  } catch (error: unknown) {
    return toInternalServerErrorResponse(error, "获取 Telegram 登录状态失败");
  }
}
