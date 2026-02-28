import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { ilikeContains } from "@/lib/sql-like";
import { toPublicErrorMessage } from "@/lib/api-error";
import { getTrimmedString, parseEnumValue, parseIntSafe, splitKeywords } from "@/lib/utils";

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

    const groupName = getTrimmedString(params.get("groupName") ?? params.get("group_name"));
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const sourceChannelId = getTrimmedString(params.get("sourceChannelId"));
    const levelRaw = getTrimmedString(params.get("level"));
    const q = getTrimmedString(params.get("q"));
    const keywords = q ? splitKeywords(q) : [];
    const limitRaw = getTrimmedString(params.get("limit"));

    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(Math.max(limitParsed ?? 50, 1), 200);

    const level = levelRaw ? parseEnumValue(schema.eventLevelEnum.enumValues, levelRaw) : null;

    const whereConditions = [
      sourceChannelId ? eq(schema.syncEvents.sourceChannelId, sourceChannelId) : undefined,
      !sourceChannelId && hasGroupParam ? eq(schema.sourceChannels.groupName, groupName) : undefined,
      level ? eq(schema.syncEvents.level, level) : undefined,
      ...keywords.map((k) => ilikeContains(schema.syncEvents.message, k)),
    ];

    const where = and(...whereConditions);

    const rows = await db
      .select({
        id: schema.syncEvents.id,
        sourceChannelId: schema.syncEvents.sourceChannelId,
        level: schema.syncEvents.level,
        message: schema.syncEvents.message,
        createdAt: schema.syncEvents.createdAt,
        sourceName: schema.sourceChannels.name,
        sourceChannelIdentifier: schema.sourceChannels.channelIdentifier,
        sourceUsername: schema.sourceChannels.username,
      })
      .from(schema.syncEvents)
      .leftJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncEvents.sourceChannelId))
      .where(where)
      .orderBy(desc(schema.syncEvents.createdAt), desc(schema.syncEvents.id))
      .limit(limit);

    const response = NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        sourceChannelId: r.sourceChannelId ?? null,
        level: r.level,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        source: r.sourceChannelId
          ? {
              id: r.sourceChannelId,
              name: r.sourceName,
              channelIdentifier: r.sourceChannelIdentifier,
              username: r.sourceUsername,
            }
          : null,
      })),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    console.error(error);
    const message = toPublicErrorMessage(error, "加载事件失败");
    const cause = getErrorCauseMessage(error);
    return NextResponse.json(
      { error: message, cause: process.env.NODE_ENV === "production" ? undefined : cause },
      { status: 500 },
    );
  }
}
