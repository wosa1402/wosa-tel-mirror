import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@tg-back/db";
import { schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toInternalServerErrorResponse } from "@/lib/api-response";

loadEnv();

export async function POST(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "telegram_session"));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return toInternalServerErrorResponse(error, "退出 Telegram 登录失败");
  }
}
