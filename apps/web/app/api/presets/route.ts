import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { getTrimmedString } from "@/lib/utils";

loadEnv();

const SETTINGS_KEY = "ui_presets_v1";
const MAX_PRESETS_PER_SCOPE = 50;

type PresetScope = "messages" | "tasks" | "events" | "channels";

const SCOPES: PresetScope[] = ["messages", "tasks", "events", "channels"];

type QueryPreset = {
  id: string;
  name: string;
  query: string;
  createdAt: number;
};

type UiPresetsValue = {
  version: 1;
  messages: QueryPreset[];
  tasks: QueryPreset[];
  events: QueryPreset[];
  channels: QueryPreset[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  return name.slice(0, 50);
}

function clampQuery(value: string): string {
  const query = value.trim();
  // query string 主要是 URLSearchParams，通常很短，这里给一个安全上限避免写入过大 JSON
  return query.slice(0, 8000);
}

function safeParsePresetList(input: unknown): QueryPreset[] {
  if (!Array.isArray(input)) return [];
  const out: QueryPreset[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const id = getTrimmedString(item.id);
    const name = clampName(getTrimmedString(item.name));
    const query = clampQuery(getTrimmedString(item.query));
    const createdAtRaw = item.createdAt;
    const createdAt =
      typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.trunc(createdAtRaw) : 0;
    if (!id || !name) continue;
    out.push({ id, name, query, createdAt });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, MAX_PRESETS_PER_SCOPE);
}

function emptyValue(): UiPresetsValue {
  return { version: 1, messages: [], tasks: [], events: [], channels: [] };
}

function normalizeValue(raw: unknown): UiPresetsValue {
  if (!isRecord(raw)) return emptyValue();
  return {
    version: 1,
    messages: safeParsePresetList(raw.messages),
    tasks: safeParsePresetList(raw.tasks),
    events: safeParsePresetList(raw.events),
    channels: safeParsePresetList(raw.channels),
  };
}

function isPresetScope(value: unknown): value is PresetScope {
  return SCOPES.includes(value as PresetScope);
}

async function loadUiPresets(): Promise<UiPresetsValue> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTINGS_KEY))
    .limit(1);
  return normalizeValue(row?.value);
}

async function saveUiPresets(value: UiPresetsValue): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    });
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const scopeRaw = getTrimmedString(url.searchParams.get("scope"));
    const scope = isPresetScope(scopeRaw) ? scopeRaw : null;

    const value = await loadUiPresets();

    if (scope) {
      return NextResponse.json({ scope, presets: value[scope] });
    }

    return NextResponse.json({
      presetsByScope: {
        messages: value.messages,
        tasks: value.tasks,
        events: value.events,
        channels: value.channels,
      },
    });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "加载预设失败") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const scope = isPresetScope(body?.scope) ? (body.scope as PresetScope) : null;
    const name = clampName(getTrimmedString(body?.name));
    const query = clampQuery(getTrimmedString(body?.query));

    if (!scope) return NextResponse.json({ error: "scope is required" }, { status: 400 });
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    const value = await loadUiPresets();

    const preset: QueryPreset = {
      id: crypto.randomUUID(),
      name,
      query,
      createdAt: Date.now(),
    };

    const nextList = [preset, ...value[scope]].slice(0, MAX_PRESETS_PER_SCOPE);
    const nextValue: UiPresetsValue = { ...value, [scope]: nextList };

    await saveUiPresets(nextValue);

    return NextResponse.json({ scope, preset, presets: nextList });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "保存预设失败") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const scope = isPresetScope(body?.scope) ? (body.scope as PresetScope) : null;
    const id = getTrimmedString(body?.id);

    if (!scope) return NextResponse.json({ error: "scope is required" }, { status: 400 });
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const value = await loadUiPresets();
    const nextList = value[scope].filter((p) => p.id !== id);
    const nextValue: UiPresetsValue = { ...value, [scope]: nextList };

    await saveUiPresets(nextValue);

    return NextResponse.json({ scope, presets: nextList });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "删除预设失败") }, { status: 500 });
  }
}
