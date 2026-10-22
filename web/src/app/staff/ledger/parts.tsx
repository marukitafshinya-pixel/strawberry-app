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

/** 名前で探すときにそろえる（全角・半角、カタカナ・ひらがな、大文字・小文字） */
const searchKey = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s/g, "");

/**
 * プルダウンに出す科目を選ぶ（エクセルの絞り込みのように、名前で探す・すべて入れる・すべて外す・1つずつチェック）。
 * 1つも選ばないときは、全部の科目を出す
 */
export function PickFilter({ accounts, pick, onChange }: { accounts: Account[]; pick: string[]; onChange: (pick: string[]) => void }) {
  // 表の中（横にスクロールする枠）でも切れないように、画面に対して位置を決めて出す
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const [q, setQ] = useState("");
  const list = accounts.filter((a) => !a.hidden);
  const key = searchKey(q);
  const shown = key ? list.filter((a) => searchKey(`${a.code}${fullName(accounts, a)}`).includes(key)) : list;
  const on = new Set(pick);
  const set = (codes: string[], checked: boolean) => {
    const next = new Set(on);
    for (const c of codes) {
      if (checked) next.add(c);
      else next.delete(c);
    }
    onChange(list.map((a) => a.code).filter((c) => next.has(c)));
  };
  return (
    <span className="inline-block align-middle print:hidden">
      <button
        type="button"
        onClick={(e) => {
          if (open) return setOpen(null);
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ top: Math.min(r.bottom + 4, window.innerHeight - 440), left: Math.max(8, Math.min(r.left, window.innerWidth - 330)) });
        }}
        className={`ml-1 rounded border px-1.5 py-0.5 text-xs font-normal ${pick.length ? "border-berry bg-berry/10 text-berry" : "bg-white text-gray-600"}`}
        aria-label="プルダウンに出す科目を選ぶ"
        title="プルダウンに出す科目を選ぶ"
      >
        ▼ {pick.length ? `${pick.length}科目` : "全部"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(null)} />
          <div style={{ top: Math.max(8, open.top), left: open.left }} className="fixed z-50 w-80 rounded-xl border bg-white p-2 text-left text-sm font-normal text-gray-800 shadow-xl">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="名前・コードで探す"
              aria-label="科目を名前で探す"
              className="w-full rounded border px-2 py-1"
            />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => set(shown.map((a) => a.code), true)} className="flex-1 rounded border px-2 py-1 text-xs">
                すべて入れる{key ? "（見つけた分）" : ""}
              </button>
              <button type="button" onClick={() => set(shown.map((a) => a.code), false)} className="flex-1 rounded border px-2 py-1 text-xs">
                すべて外す{key ? "（見つけた分）" : ""}
              </button>
            </div>
            <ul className="mt-2 max-h-72 overflow-auto">
              {shown.map((a) => (
                <li key={a.code}>
                  <label className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-50 ${a.parent ? "pl-5" : ""}`}>
                    <input type="checkbox" checked={on.has(a.code)} onChange={(e) => set([a.code], e.target.checked)} />
                    <span className="text-xs text-gray-400 tabular-nums">{a.code}</span>
                    <span>{fullName(accounts, a)}</span>
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="px-1 py-2 text-xs text-gray-500">見つかりません</li>}
            </ul>
            <p className="mt-2 border-t pt-1 text-xs text-gray-500">チェックした科目だけがプルダウンに出ます（1つもなければ全部）。選ぶとすぐ保存します。</p>
          </div>
        </>
      )}
    </span>
  );
}
