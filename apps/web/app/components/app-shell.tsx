"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  BookOpenText,
  Eye,
  History,
  Network,
  PenLine,
  Rocket,
  Settings2,
} from "lucide-react";

const navItems = [
  { href: "/", label: "创作台", icon: PenLine },
  { href: "/preview", label: "预览台", icon: Eye },
  { href: "/publish", label: "发布确认", icon: Rocket },
  { href: "/tasks", label: "任务中心", icon: History },
  { href: "/accounts", label: "账号管理", icon: Settings2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <aside className="side-rail" aria-label="主导航">
        <Link href="/" className="brand-lockup" aria-label="MP-Publishing 首页">
          <span className="brand-mark">
            <BookOpenText size={20} />
          </span>
          <span>
            <strong>MP-Publishing</strong>
            <small>内容同步发布工作台</small>
          </span>
        </Link>

        <nav className="nav-stack">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

            return (
              <Link key={item.href} href={item.href} className={active ? "nav-item active" : "nav-item"}>
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="rail-note">
          <Network size={18} />
          <span>本地 API 默认连接 http://localhost:3001</span>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}
