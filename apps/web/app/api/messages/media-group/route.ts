import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

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

function getTrimmedString(value: string | null): string {
  if (!value) return "";
  return value.trim();
}

function parseIntSafe(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return value;
  return String(value);
}

function buildTelegramMessageLink(
  channel: { username?: string | null; telegramId?: bigint | null },
  messageId: number | null,
): string | null {
  if (!messageId) return null;
  const username = typeof channel.username === "string" ? channel.username.trim().replace(/^@/, "") : "";
  if (username) return `https://t.me/${username}/${messageId}`;
  const telegramId = channel.telegramId;
  if (typeof telegramId === "bigint") return `https://t.me/c/${telegramId.toString()}/${messageId}`;
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const params = url.searchParams;

    const sourceChannelId = getTrimmedString(params.get("sourceChannelId") ?? params.get("source_channel_id"));
    const mediaGroupIdRaw = getTrimmedString(params.get("mediaGroupId") ?? params.get("media_group_id"));
    const mediaGroupId = mediaGroupIdRaw.slice(0, 128);
    if (!sourceChannelId) return NextResponse.json({ error: "sourceChannelId is required" }, { status: 400 });
    if (!mediaGroupId) return NextResponse.json({ error: "mediaGroupId is required" }, { status: 400 });

    const limitRaw = getTrimmedString(params.get("limit"));
    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(Math.max(limitParsed ?? 50, 1), 200);

    const rows = await db
      .select({
        id: schema.messageMappings.id,
        sourceMessageId: schema.messageMappings.sourceMessageId,
        mirrorMessageId: schema.messageMappings.mirrorMessageId,
        messageType: schema.messageMappings.messageType,
        status: schema.messageMappings.status,
        skipReason: schema.messageMappings.skipReason,
        errorMessage: schema.messageMappings.errorMessage,
        retryCount: schema.messageMappings.retryCount,
        hasMedia: schema.messageMappings.hasMedia,
        fileSize: schema.messageMappings.fileSize,
        textPreview: schema.messageMappings.textPreview,
        text: schema.messageMappings.text,
        sentAt: schema.messageMappings.sentAt,
        mirroredAt: schema.messageMappings.mirroredAt,
        isDeleted: schema.messageMappings.isDeleted,
        deletedAt: schema.messageMappings.deletedAt,
        editCount: schema.messageMappings.editCount,
        lastEditedAt: schema.messageMappings.lastEditedAt,
        sourceTelegramId: schema.sourceChannels.telegramId,
        sourceUsername: schema.sourceChannels.username,
        mirrorTelegramId: schema.mirrorChannels.telegramId,
        mirrorUsername: schema.mirrorChannels.username,
      })
      .from(schema.messageMappings)
      .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.messageMappings.sourceChannelId))
      .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.id, schema.messageMappings.mirrorChannelId))
      .where(
        and(
          eq(schema.messageMappings.sourceChannelId, sourceChannelId),
          eq(schema.messageMappings.mediaGroupId, mediaGroupId),
        ),
      )
      .orderBy(asc(schema.messageMappings.sourceMessageId))
      .limit(limit);

    const response = NextResponse.json({
      sourceChannelId,
      mediaGroupId,
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        sourceChannelId,
        sourceMessageId: r.sourceMessageId,
        mirrorMessageId: r.mirrorMessageId,
        messageType: r.messageType,
        status: r.status,
        skipReason: r.skipReason,
        errorMessage: r.errorMessage,
        retryCount: r.retryCount,
        hasMedia: r.hasMedia,
        fileSize: r.fileSize ?? null,
        textPreview: r.textPreview,
        text: r.text,
        sentAt: r.sentAt.toISOString(),
        mirroredAt: r.mirroredAt ? r.mirroredAt.toISOString() : null,
        isDeleted: r.isDeleted,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        editCount: r.editCount,
        lastEditedAt: r.lastEditedAt ? r.lastEditedAt.toISOString() : null,
        links: {
          source: buildTelegramMessageLink({ username: r.sourceUsername, telegramId: r.sourceTelegramId }, r.sourceMessageId),
          mirror: buildTelegramMessageLink({ username: r.mirrorUsername, telegramId: r.mirrorTelegramId }, r.mirrorMessageId),
        },
        sourceChannel: {
          telegramId: toStringOrNull(r.sourceTelegramId),
          username: r.sourceUsername,
        },
        mirrorChannel: {
          telegramId: toStringOrNull(r.mirrorTelegramId),
          username: r.mirrorUsername,
        },
      })),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const cause = getErrorCauseMessage(error);
    return NextResponse.json(
      { error: message, cause: process.env.NODE_ENV === "production" ? undefined : cause },
      { status: 500 },
    );
  }
}

