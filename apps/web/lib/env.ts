import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

let loaded = false;

function findRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot) {
    dotenv.config({ path: path.join(repoRoot, ".env") });
  }

  dotenv.config();
}

