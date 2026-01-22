import { createLocalQueryPreset, readLocalQueryPresets, writeLocalQueryPresets, type LocalQueryPreset } from "@/lib/local-presets";

export type PresetScope = "messages" | "tasks" | "events" | "channels";

const MAX_PRESETS_PER_SCOPE = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeTrim(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizePresets(input: unknown): LocalQueryPreset[] {
  if (!Array.isArray(input)) return [];
  const out: LocalQueryPreset[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const id = safeTrim(item.id);
    const name = safeTrim(item.name).slice(0, 50);
    const query = safeTrim(item.query);
    const createdAtRaw = item.createdAt;
    const createdAt = typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) ? Math.trunc(createdAtRaw) : 0;
    if (!id || !name) continue;
    out.push({ id, name, query, createdAt });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, MAX_PRESETS_PER_SCOPE);
}

function buildSignature(preset: Pick<LocalQueryPreset, "name" | "query">): string {
  return `${preset.name.trim().toLowerCase()}|${preset.query.trim()}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function loadQueryPresets(args: { scope: PresetScope; storageKey?: string }): Promise<LocalQueryPreset[]> {
  const { scope, storageKey } = args;

  try {
    const { ok, data } = await fetchJson(`/api/presets?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
    if (!ok) throw new Error(isRecord(data) ? safeTrim(data.error) : "");

    const serverPresets = normalizePresets(isRecord(data) ? data.presets : null);

    if (!storageKey) return serverPresets;

    const localPresets = readLocalQueryPresets(storageKey);
    if (!localPresets.length) {
      writeLocalQueryPresets(storageKey, serverPresets);
      return serverPresets;
    }

    const serverSig = new Set(serverPresets.map((p) => buildSignature(p)));
    const missingLocal = localPresets.filter((p) => !serverSig.has(buildSignature(p))).slice(0, 10);
    if (!missingLocal.length) {
      writeLocalQueryPresets(storageKey, serverPresets);
      return serverPresets;
    }

    // 迁移：把本地已有的预设补到服务端（避免升级后“预设突然消失”）
    for (const p of missingLocal) {
      await fetchJson("/api/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, name: p.name, query: p.query }),
      }).catch(() => null);
    }

    const { ok: ok2, data: data2 } = await fetchJson(`/api/presets?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
    if (!ok2) {
      writeLocalQueryPresets(storageKey, localPresets);
      return localPresets;
    }

    const merged = normalizePresets(isRecord(data2) ? data2.presets : null);
    writeLocalQueryPresets(storageKey, merged);
    return merged;
  } catch {
    if (storageKey) return readLocalQueryPresets(storageKey);
    return [];
  }
}

export async function saveQueryPreset(args: {
  scope: PresetScope;
  name: string;
  query: string;
  storageKey?: string;
}): Promise<LocalQueryPreset[]> {
  const { scope, name, query, storageKey } = args;

  try {
    const { ok, data } = await fetchJson("/api/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, name, query }),
    });
    if (!ok) throw new Error(isRecord(data) ? safeTrim(data.error) : "");

    const presets = normalizePresets(isRecord(data) ? data.presets : null);
    if (storageKey) writeLocalQueryPresets(storageKey, presets);
    return presets;
  } catch {
    if (!storageKey) return [];
    const next = [createLocalQueryPreset({ name, query }), ...readLocalQueryPresets(storageKey)].slice(0, MAX_PRESETS_PER_SCOPE);
    writeLocalQueryPresets(storageKey, next);
    return next;
  }
}

export async function deleteQueryPreset(args: { scope: PresetScope; id: string; storageKey?: string }): Promise<LocalQueryPreset[]> {
  const { scope, id, storageKey } = args;

  try {
    const { ok, data } = await fetchJson("/api/presets", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, id }),
    });
    if (!ok) throw new Error(isRecord(data) ? safeTrim(data.error) : "");

    const presets = normalizePresets(isRecord(data) ? data.presets : null);
    if (storageKey) writeLocalQueryPresets(storageKey, presets);
    return presets;
  } catch {
    if (!storageKey) return [];
    const next = readLocalQueryPresets(storageKey).filter((p) => p.id !== id);
    writeLocalQueryPresets(storageKey, next);
    return next;
  }
}

