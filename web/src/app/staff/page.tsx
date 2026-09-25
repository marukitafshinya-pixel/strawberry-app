"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { todayJST } from "@/lib/date";
import { usePendingRequests } from "@/lib/reservations";

type MenuItem = { label: string; href?: string; adminOnly?: boolean };

// まだ作っていない機能は「準備中」と表示する。作るたびにリンクに変えていく
const MENU: MenuItem[] = [
  { label: "予約管理", href: "/staff/reservations/" },
  { label: "会計", href: "/staff/checkout/" },
  { label: "売掛管理", href: "/staff/receivables/" },
  { label: "日次締め", href: "/staff/sales/" },
  { label: "ダッシュボード", href: "/staff/dashboard/" },
  { label: "集計（期間指定）", href: "/staff/report/" },
  { label: "予約の集計", href: "/staff/report/reservations/" },
  { label: "設定", href: "/staff/settings/", adminOnly: true },
  { label: "スタッフ管理", href: "/staff/members/", adminOnly: true },
  { label: "過去売上の取り込み", href: "/staff/import/", adminOnly: true },
];

export default function StaffHome() {
  const { role } = useAuth();
  const items = MENU.filter((m) => !m.adminOnly || role === "admin");
  const { value: requests } = usePendingRequests(todayJST());

  return (
    <>
      <h1 className="text-xl font-bold">メニュー</h1>
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((m) =>
          m.href ? (
            <li key={m.label}>
              <Link
                href={m.href}
                className="block rounded-xl border border-berry/30 bg-white p-5 text-center shadow-sm active:bg-berry/5"
              >
                <div className="text-lg font-semibold">{m.label}</div>
                {m.href === "/staff/reservations/" && requests && requests.length > 0 && (
                  <div className="mt-1 inline-block rounded-full bg-purple-700 px-2 py-0.5 text-xs text-white">
                    リクエスト {requests.length}件
                  </div>
                )}
              </Link>
            </li>
          ) : (
            <li key={m.label} className="rounded-xl border bg-white p-5 text-center text-gray-400">
              <div className="text-lg font-semibold">{m.label}</div>
              <div className="mt-1 text-xs">準備中</div>
            </li>
          ),
        )}
      </ul>
    </>
  );
}
