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

export function setupFileLogging(): { filePath: string } | null {
  const raw = process.env.MIRROR_LOG_FILE?.trim();
  if (!raw) return null;

  try {
    const filePath = resolveLogFilePath(raw);
    ensureParentDir(filePath);

    const stream = fs.createWriteStream(filePath, { flags: "a" });
    let enabled = true;

    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    const disable = (reason: string) => {
      if (!enabled) return;
      enabled = false;
      try {
        stream.end();
      } catch {
        // ignore
      }
      originalWarn(`[file-logging] 文件日志写入失败，已自动关闭（${reason}）`);
    };

    stream.on("error", (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      disable(msg);
    });

    const writeLine = (level: LogLevel, args: unknown[]): void => {
      if (!enabled) return;
      const msg = formatMessage(...args.map(stringifyArg));
      stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
    };

    console.log = (...args: unknown[]) => {
      originalLog(...args);
      writeLine("INFO", args);
    };
    console.warn = (...args: unknown[]) => {
      originalWarn(...args);
      writeLine("WARN", args);
    };
    console.error = (...args: unknown[]) => {
      originalError(...args);
      writeLine("ERROR", args);
    };

    const scheduleFatalExit = () => {
      const exitCode = process.exitCode && Number.isFinite(process.exitCode) ? process.exitCode : 1;
      setTimeout(() => process.exit(exitCode), 200).unref();
    };

    process.on("unhandledRejection", (reason) => {
      writeLine("ERROR", ["unhandledRejection:", reason]);
      originalError("unhandledRejection:", reason);
      process.exitCode = 1;
      scheduleFatalExit();
    });

    process.on("uncaughtException", (error) => {
      writeLine("ERROR", ["uncaughtException:", error]);
      originalError("uncaughtException:", error);
      process.exitCode = 1;
      scheduleFatalExit();
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
