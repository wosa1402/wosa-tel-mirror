export async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms)) return;
  const safeMs = Math.max(0, Math.floor(ms));
  if (safeMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, safeMs));
}
