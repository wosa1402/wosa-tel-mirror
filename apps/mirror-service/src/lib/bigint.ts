export function toBigIntOrNull(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && value && "toString" in value) {
    const str = String((value as { toString: () => string }).toString()).trim();
    if (!str || str === "[object Object]") return null;
    if (!/^-?\d+$/.test(str)) return null;
    try {
      return BigInt(str);
    } catch {
      return null;
    }
  }
  return null;
}
