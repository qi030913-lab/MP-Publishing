import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "MP-Publishing",
  description: "Multi-platform content adaptation and publishing workspace.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
