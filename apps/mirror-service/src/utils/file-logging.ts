import fs from "node:fs";
import path from "node:path";
import { format as formatMessage } from "node:util";

type LogLevel = "INFO" | "WARN" | "ERROR";

function getRepoRoot(): string {
  const packageRoot = path.resolve(__dirname, "../..");
  return path.resolve(packageRoot, "../..");
}

function resolveLogFilePath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(getRepoRoot(), value);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function stringifyArg(arg: unknown): unknown {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  return arg;
}

function writeLine(stream: fs.WriteStream, level: LogLevel, args: unknown[]): void {
  const msg = formatMessage(...args.map(stringifyArg));
  stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

export function setupFileLogging(): { filePath: string } | null {
  const raw = process.env.MIRROR_LOG_FILE?.trim();
  if (!raw) return null;

  try {
    const filePath = resolveLogFilePath(raw);
    ensureParentDir(filePath);

    const stream = fs.createWriteStream(filePath, { flags: "a" });

    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      originalLog(...args);
      writeLine(stream, "INFO", args);
    };
    console.warn = (...args: unknown[]) => {
      originalWarn(...args);
      writeLine(stream, "WARN", args);
    };
    console.error = (...args: unknown[]) => {
      originalError(...args);
      writeLine(stream, "ERROR", args);
    };

    process.on("unhandledRejection", (reason) => {
      writeLine(stream, "ERROR", ["unhandledRejection:", reason]);
    });

    process.on("uncaughtException", (error) => {
      writeLine(stream, "ERROR", ["uncaughtException:", error]);
    });

    const closeStream = () => {
      try {
        stream.end();
      } catch {
        // ignore
      }
    };

    process.once("SIGINT", closeStream);
    process.once("SIGTERM", closeStream);
    process.once("beforeExit", closeStream);

    return { filePath };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to enable file logging: ${msg}`);
    return null;
  }
}
