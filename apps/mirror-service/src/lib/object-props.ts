export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readProp(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function readStringProp(value: unknown, key: string): string | undefined {
  const v = readProp(value, key);
  return typeof v === "string" ? v : undefined;
}

export function readNumberProp(value: unknown, key: string): number | undefined {
  const v = readProp(value, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readBooleanProp(value: unknown, key: string): boolean | undefined {
  const v = readProp(value, key);
  return typeof v === "boolean" ? v : undefined;
}

export function readArrayProp(value: unknown, key: string): unknown[] | undefined {
  const v = readProp(value, key);
  return Array.isArray(v) ? v : undefined;
}

