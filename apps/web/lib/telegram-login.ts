import { TelegramClient } from "telegram";

export interface LoginSession {
  client: TelegramClient;
  phoneCodeHash: string;
  phoneNumber: string;
  createdAt: number;
}

export const loginSessions = new Map<string, LoginSession>();

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  const timeoutMs = 30 * 60 * 1000;

  for (const [loginId, session] of loginSessions.entries()) {
    if (now - session.createdAt > timeoutMs) {
      session.client.disconnect().catch(() => {});
      loginSessions.delete(loginId);
    }
  }
}

const globalForLogin = globalThis as unknown as {
  __tgBackLoginCleanupIntervalStarted?: boolean;
};

if (!globalForLogin.__tgBackLoginCleanupIntervalStarted) {
  globalForLogin.__tgBackLoginCleanupIntervalStarted = true;
  setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
}

