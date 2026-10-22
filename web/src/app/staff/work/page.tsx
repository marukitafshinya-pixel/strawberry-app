"use client";

// 作業用フォルダ（管理者だけ）：ふだんの業務とは別の、まとめ作業の画面を置く
import Link from "next/link";
import { useAuth } from "@/lib/auth";

const TOOLS = [{ label: "🧾 経費の仕分け", href: "/staff/work/expenses/", note: "総勘定元帳を読み込んで、仕入れ先ごとにまとめる（来年度予算の参考）" }];

export default function WorkFolder() {
  const { role } = useAuth();
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  return (
    <div className="max-w-2xl">
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">🗂 作業用フォルダ</h1>
      <div className="mt-4 grid gap-3">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="block rounded-xl border bg-white p-4 shadow-sm hover:border-berry">
            <p className="text-lg font-bold">{t.label}</p>
            <p className="mt-1 text-sm text-gray-600">{t.note}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
