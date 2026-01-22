import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

const SETTINGS_KEY = "ui_presets_v1";

type QueryPreset = {
  id: string;
  name: string;
  query: string;
  createdAt: number;
};

type PresetsByScope = {
  messages: QueryPreset[];
  tasks: QueryPreset[];
  events: QueryPreset[];
  channels: QueryPreset[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function safeParsePresetList(input: unknown): QueryPreset[] {
  if (!Array.isArray(input)) return [];
  const out: QueryPreset[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const id = getTrimmedString(item.id);
    const name = getTrimmedString(item.name).slice(0, 50);
    const query = getTrimmedString(item.query).slice(0, 8000);
    const createdAtRaw = item.createdAt;
    const createdAt =
      typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.trunc(createdAtRaw) : 0;
    if (!id || !name) continue;
    out.push({ id, name, query, createdAt });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function normalizePresetsByScope(value: unknown): PresetsByScope {
  if (!isRecord(value)) return { messages: [], tasks: [], events: [], channels: [] };
  return {
    messages: safeParsePresetList(value.messages),
    tasks: safeParsePresetList(value.tasks),
    events: safeParsePresetList(value.events),
    channels: safeParsePresetList(value.channels),
  };
}

function formatDateForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}${m}${d}-${hh}${mm}`;
}

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTINGS_KEY))
    .limit(1);

  const now = new Date();
  const stamp = formatDateForFilename(now);

  const presetsByScope = normalizePresetsByScope(row?.value);

  const body = JSON.stringify(
    {
      type: SETTINGS_KEY,
      exportedAt: now.toISOString(),
      presetsByScope,
    },
    null,
    2,
  );

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename=\"tg-back-presets-${stamp}.json\"`,
    },
  });
}

