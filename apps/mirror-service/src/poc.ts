import dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(
      `Missing env ${name}. Copy \`.env.example\` -> \`.env\` and fill required values.`,
    );
  }
  return value;
}

function parseIntStrict(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

async function readSessionFromFile(sessionFilePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf8");
    const trimmed = content.trim();
    return trimmed.length ? trimmed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSessionToFile(sessionFilePath: string, session: string): Promise<void> {
  const trimmed = session.trim();
  if (!trimmed) return;
  await fs.writeFile(sessionFilePath, `${trimmed}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  const packageRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(packageRoot, "../..");

  // Load root .env then local .env (local overrides root)
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(packageRoot, ".env"), override: true });

  const apiId = parseIntStrict("TELEGRAM_API_ID", requireEnv("TELEGRAM_API_ID"));
  const apiHash = requireEnv("TELEGRAM_API_HASH");

  const sourceChat = requireEnv("TG_POC_SOURCE_CHAT");
  const targetChat = getEnv("TG_POC_TARGET_CHAT") ?? "me";
  const mode = (getEnv("TG_POC_MODE") ?? "forward").toLowerCase();
  const limit = parseIntStrict("TG_POC_LIMIT", getEnv("TG_POC_LIMIT") ?? "5");

  if (mode !== "forward" && mode !== "copy") {
    throw new Error(`Invalid TG_POC_MODE: ${mode} (expected: forward|copy)`);
  }
  if (limit <= 0 || limit > 50) {
    throw new Error(`Invalid TG_POC_LIMIT: ${limit} (expected: 1..50)`);
  }

  const sessionFilePath = path.join(packageRoot, ".telegram-session");
  const envSession = getEnv("TELEGRAM_SESSION");
  const fileSession = await readSessionFromFile(sessionFilePath);
  const sessionString = envSession ?? fileSession ?? "";

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const phoneFromEnv = getEnv("TELEGRAM_PHONE");
    const passwordFromEnv = getEnv("TELEGRAM_2FA_PASSWORD");

    await client.start({
      phoneNumber: async () => phoneFromEnv ?? (await rl.question("Telegram phone number: ")).trim(),
      password: async () =>
        passwordFromEnv ?? (await rl.question("Telegram 2FA password (if enabled): ")).trim(),
      phoneCode: async () => (await rl.question("Telegram login code: ")).trim(),
      onError: (err) => console.error("Telegram login error:", err),
    });

    const savedSession = client.session.save() as unknown as string;
    if (!envSession) {
      await writeSessionToFile(sessionFilePath, savedSession);
      console.log(`Saved session to ${sessionFilePath}`);
    }

    const sourceEntity = await client.getEntity(sourceChat);
    const targetEntity = await client.getEntity(targetChat);

    const messages = await client.getMessages(sourceEntity, { limit });
    const ordered = [...messages].reverse();

    console.log(
      `Fetched ${messages.length} messages from ${sourceChat}. Mirroring to ${targetChat} (mode=${mode})...`,
    );

    for (const msg of ordered) {
      try {
        if (mode === "forward") {
          await client.forwardMessages(targetEntity, { messages: [msg.id], fromPeer: sourceEntity });
          continue;
        }

        const text = (msg.message ?? "").trim();
        if (!text) {
          console.log(`Skip non-text message id=${msg.id} (copy mode)`);
          continue;
        }
        await client.sendMessage(targetEntity, { message: text });
      } catch (error) {
        console.error(`Failed to mirror message id=${msg.id}:`, error);
      }
    }

    console.log("PoC done.");
  } finally {
    rl.close();
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
