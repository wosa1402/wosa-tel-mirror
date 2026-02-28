export function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function parseIntSafe(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function parseEnumValue<T extends readonly string[]>(allowed: T, value: string): T[number] | null {
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : null;
}

export function splitKeywords(raw: string, max = 5): string[] {
  const parts = raw
    .split(/\s+/g)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const keyword = p.slice(0, 50);
    const key = keyword.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= max) break;
  }
  return out;
}

export function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return String(value);
}

export function isMirrorMode(value: unknown): value is "forward" | "copy" {
  return value === "forward" || value === "copy";
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

export function calcProgressPct(current: number, total: number | null): number | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.max(0, Math.min(100, (current / total) * 100));
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "errorMessage" in error) {
    const maybeErrorMessage = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof maybeErrorMessage === "string") return maybeErrorMessage;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
