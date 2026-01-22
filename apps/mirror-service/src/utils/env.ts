import dotenv from "dotenv";
import path from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const packageRoot = path.resolve(__dirname, "../..");
  const repoRoot = path.resolve(packageRoot, "../..");

  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(packageRoot, ".env"), override: true });
  dotenv.config();
}

