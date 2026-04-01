import { NextRequest, NextResponse } from "next/server";
import { Api } from "telegram";
import { computeCheck } from "telegram/Password";
import { db } from "@tg-back/db";
import { schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { encrypt } from "@/lib/crypto";
import { cleanupExpiredSessions, loginSessions } from "@/lib/telegram-login";
import { requireApiAuth } from "@/lib/api-auth";
import { toInternalServerErrorResponse } from "@/lib/api-response";
import { getTelegramErrorMessage } from "@/lib/telegram-errors";

loadEnv();

export async function POST(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    cleanupExpiredSessions();

    const body = await request.json().catch(() => ({}));
    const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const password = typeof body.password === "string" ? body.password : undefined;

    if (!loginId || !code) {
      return NextResponse.json({ error: "loginId and code are required" }, { status: 400 });
    }

    const session = loginSessions.get(loginId);
    if (!session) {
      return NextResponse.json({ error: "Login session expired. Please restart the login process." }, { status: 400 });
    }

    const { client, phoneCodeHash, phoneNumber } = session;

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (error: unknown) {
      if (getTelegramErrorMessage(error) === "SESSION_PASSWORD_NEEDED") {
        if (!password) {
          return NextResponse.json({ requiresPassword: true, message: "请输入两步验证密码" });
        }

        const passwordInfo = await client.invoke(new Api.account.GetPassword());
        const passwordCheck = await computeCheck(passwordInfo, password);
        await client.invoke(
          new Api.auth.CheckPassword({
            password: passwordCheck,
          }),
        );
      } else {
        throw error;
      }
    }

    const sessionString = client.session.save() as unknown as string;
    const encryptedSession = encrypt(sessionString);

    await db
      .insert(schema.settings)
      .values({ key: "telegram_session", value: encryptedSession })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: encryptedSession },
      });

    loginSessions.delete(loginId);
    await client.disconnect();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const telegramMsg = getTelegramErrorMessage(error);
    if (telegramMsg) return NextResponse.json({ error: telegramMsg }, { status: 400 });
    return toInternalServerErrorResponse(error, "Telegram 登录失败");
  }
}
