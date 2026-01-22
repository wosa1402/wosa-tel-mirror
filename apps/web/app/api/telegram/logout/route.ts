import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@tg-back/db";
import { schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "telegram_session"));
  return NextResponse.json({ success: true });
}
