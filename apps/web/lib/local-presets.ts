export type LocalQueryPreset = {
  id: string;
  name: string;
  query: string;
  createdAt: number;
};

function safeParsePresets(input: string | null): LocalQueryPreset[] {
  if (!input) return [];
  try {
    const raw = JSON.parse(input) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: LocalQueryPreset[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      const query = typeof obj.query === "string" ? obj.query.trim() : "";
      const createdAt = typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) ? obj.createdAt : 0;
      if (!id || !name) continue;
      out.push({ id, name, query, createdAt });
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch {
    return [];
  }
}

function safeStringifyPresets(value: LocalQueryPreset[]): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function randomId(): string {
  try {
    const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
    const uuid = cryptoObj?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function readLocalQueryPresets(storageKey: string): LocalQueryPreset[] {
  if (typeof window === "undefined") return [];
  try {
    return safeParsePresets(window.localStorage.getItem(storageKey));
  } catch {
    return [];
  }
}

export function writeLocalQueryPresets(storageKey: string, presets: LocalQueryPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, safeStringifyPresets(presets));
  } catch {
    // ignore (quota / blocked)
  }
}

export function createLocalQueryPreset(args: { name: string; query: string }): LocalQueryPreset {
  const name = args.name.trim().slice(0, 50);
  const query = args.query.trim();
  return { id: randomId(), name, query, createdAt: Date.now() };
}

