"use client";

import { useAuth } from "@/lib/auth";

type MenuItem = { label: string; adminOnly?: boolean };

// まだ作っていない機能は「準備中」と表示する。作るたびにリンクに変えていく
const MENU: MenuItem[] = [
  { label: "予約管理" },
  { label: "会計" },
  { label: "売掛管理" },
  { label: "日次締め" },
  { label: "ダッシュボード" },
  { label: "設定", adminOnly: true },
  { label: "スタッフ管理", adminOnly: true },
];

export default function StaffHome() {
  const { role } = useAuth();
  const items = MENU.filter((m) => !m.adminOnly || role === "admin");

  return (
    <>
      <h1 className="text-xl font-bold">メニュー</h1>
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((m) => (
          <li key={m.label} className="rounded-xl border bg-white p-5 text-center text-gray-400">
            <div className="text-lg font-semibold">{m.label}</div>
            <div className="mt-1 text-xs">準備中</div>
          </li>
        ))}
      </ul>
    </>
  );
}
