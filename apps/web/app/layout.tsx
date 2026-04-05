import type { Metadata } from "next";
import { AccessGuard } from "@/components/auth/AccessGuard";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "tg-back",
  description: "Telegram 频道备份系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <AccessGuard>
          <AppShell>{children}</AppShell>
        </AccessGuard>
      </body>
    </html>
  );
}
