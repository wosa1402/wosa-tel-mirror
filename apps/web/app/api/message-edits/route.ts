import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { getTrimmedString, parseIntSafe } from "@/lib/utils";

loadEnv();

function getErrorCauseMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if (!("cause" in error)) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return null;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const params = url.searchParams;

    const messageMappingId = getTrimmedString(params.get("messageMappingId") ?? params.get("message_mapping_id"));
    if (!messageMappingId) return NextResponse.json({ error: "messageMappingId is required" }, { status: 400 });

    const limitRaw = getTrimmedString(params.get("limit"));
    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(Math.max(limitParsed ?? 50, 1), 200);

    const rows = await db
      .select({
        id: schema.messageEdits.id,
        messageMappingId: schema.messageEdits.messageMappingId,
        version: schema.messageEdits.version,
        previousText: schema.messageEdits.previousText,
        newText: schema.messageEdits.newText,
        editedAt: schema.messageEdits.editedAt,
        createdAt: schema.messageEdits.createdAt,
      })
      .from(schema.messageEdits)
      .where(eq(schema.messageEdits.messageMappingId, messageMappingId))
      .orderBy(desc(schema.messageEdits.version))
      .limit(limit);

    const response = NextResponse.json({
      edits: rows.map((r) => ({
        id: r.id,
        messageMappingId: r.messageMappingId,
        version: r.version,
        previousText: r.previousText ?? null,
        newText: r.newText ?? null,
        editedAt: r.editedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    console.error(error);
    const message = toPublicErrorMessage(error, "加载编辑记录失败");
    const cause = getErrorCauseMessage(error);
    return NextResponse.json(
      { error: message, cause: process.env.NODE_ENV === "production" ? undefined : cause },
      { status: 500 },
    );
  }
}
