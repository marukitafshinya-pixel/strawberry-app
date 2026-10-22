"use client";

// 帳簿の画面で共通に使う部品（上のタブ・科目のプルダウン・金額の入力）
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { fullName, KIND_LABEL, KINDS, type Account } from "@/lib/books";

export const yen = (n: number) => n.toLocaleString("ja-JP");

const TABS = [
  { href: "/staff/ledger/", label: "仕訳帳" },
  { href: "/staff/ledger/bank/", label: "預金通帳" },
  { href: "/staff/ledger/reports/", label: "決算書・元帳" },
  { href: "/staff/ledger/accounts/", label: "勘定科目" },
  { href: "/staff/ledger/import/", label: "会計ソフトから取り込み" },
];

/** 帳簿の画面の見出しとタブ。管理者と経理担当だけが使える */
export function LedgerHeader({ title }: { title: string }) {
  const { role } = useAuth();
  const pathname = usePathname();
  return (
    <div className="print:hidden">
      <p className="flex gap-4 text-sm">
        {role === "admin" && (
          <Link href="/staff/" className="text-gray-500 underline">
            ← メニュー
          </Link>
        )}
        <Link href="/staff/cashbook/" className="text-gray-500 underline">
          現金出納帳
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">帳簿（経理）　{title}</h1>
      <nav className="mt-3 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const on = pathname === t.href || pathname === t.href.replace(/\/$/, "");
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-lg border px-4 py-2 text-sm font-bold ${on ? "border-berry bg-berry text-white" : "border-berry bg-white text-berry"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function canUseLedger(role: string | null) {
  return role === "admin" || role === "accounting";
}

/** 勘定科目のプルダウン（種類ごとにまとめる） */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label,
  empty: emptyLabel,
  only,
  className = "",
}: {
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  label: string;
  empty?: string;
  /** 出す科目だけ（空・なしなら全部）。選んである科目はいつも出す */
  only?: string[];
  className?: string;
}) {
  const shown = only && only.length ? accounts.filter((a) => only.includes(a.code) || a.code === value) : accounts;
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} className={`rounded border bg-white px-1 py-1 ${className}`}>
      <option value="">{emptyLabel ?? "（科目を選ぶ）"}</option>
      {value && !accounts.some((a) => a.code === value) && <option value={value}>（未登録 {value}）</option>}
      {KINDS.filter((k) => shown.some((a) => a.kind === k)).map((k) => (
        <optgroup key={k} label={KIND_LABEL[k]}>
          {shown
            .filter((a) => a.kind === k && (!a.hidden || a.code === value))
            .map((a) => (
              <option key={a.code} value={a.code}>
                {a.parent ? "　└ " : ""}
                {a.code} {fullName(accounts, a)}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

/** 金額の入力（全角の数字も読む） */
export function Amount({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const fmt = (v: number | null) => (v === null ? "" : String(v));
  const [text, setText] = useState(fmt(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(fmt(value));
  }
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => {
        // マイナス（返品など）も入れられる
        const t = e.target.value
          .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
          .replace(/[−ー－▲]/g, "-")
          .replace(/[^0-9-]/g, "")
          .replace(/(?!^)-/g, "");
        setText(t);
        onChange(t === "" || t === "-" ? null : Math.max(-999_999_999, Math.min(999_999_999, Number(t))));
      }}
      className="w-full rounded border px-2 py-1 text-right tabular-nums"
    />
  );
}
