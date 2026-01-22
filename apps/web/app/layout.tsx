import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AccessGuard } from "@/components/auth/AccessGuard";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AccessGuard>
          <AppShell>{children}</AppShell>
        </AccessGuard>
      </body>
    </html>
  );
}
