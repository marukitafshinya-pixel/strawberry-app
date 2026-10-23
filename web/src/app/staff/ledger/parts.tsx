"use client";

// 帳簿の画面で共通に使う部品（上のタブ・科目のプルダウン・金額の入力）
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { fullName, KIND_LABEL, KINDS, matchAccount, rankAccount, sectionOf, SECTIONS, type Account } from "@/lib/books";

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

/** 帳簿を使えるか：管理者・経理・スタッフ（スタッフ・経理は、帳簿を見せているかを画面の入口（StaffShell）で確かめる） */
export function canUseLedger(role: string | null) {
  return role === "admin" || role === "accounting" || role === "staff";
}

/**
 * 科目を、プルダウンで見やすいようにまとめる：資産・負債・純資産は種類ごと、収益・費用は損益計算書の区分ごと
 * （例「販管費：その他経費」「製造原価：製造経費」）
 */
export function accountGroups(list: Account[]): { label: string; accounts: Account[] }[] {
  const groups: { label: string; accounts: Account[] }[] = [];
  for (const k of KINDS) {
    if (k === "revenue" || k === "expense") {
      for (const sec of SECTIONS.filter((x) => x.kind === k)) groups.push({ label: sec.label, accounts: list.filter((a) => a.kind === k && sectionOf(a) === sec.key) });
    } else groups.push({ label: KIND_LABEL[k], accounts: list.filter((a) => a.kind === k) });
  }
  return groups.filter((g) => g.accounts.length > 0);
}

/** 勘定科目のプルダウン（種類・区分ごとにまとめる） */
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
      {accountGroups(shown.filter((a) => !a.hidden || a.code === value)).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.accounts
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

/**
 * プルダウンに出す科目を選ぶ（エクセルの絞り込みのように、名前で探す・すべて入れる・すべて外す・1つずつチェック）。
 * 1つも選ばないときは、全部の科目を出す
 */
export function PickFilter({ accounts, pick, onChange }: { accounts: Account[]; pick: string[]; onChange: (pick: string[]) => void }) {
  // 表の中（横にスクロールする枠）でも切れないように、画面に対して位置を決めて出す
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const [q, setQ] = useState("");
  const list = accounts.filter((a) => !a.hidden);
  const key = q.trim();
  const shown = key ? list.filter((a) => matchAccount(accounts, a, key)) : list;
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
              placeholder="名前・読み・コードで探す（syu・しゅ など）"
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
              {accountGroups(shown).map((g) => (
                <li key={g.label}>
                  <p className="sticky top-0 bg-gray-100 px-1 py-0.5 text-xs font-bold text-gray-600">{g.label}</p>
                  <ul>
                    {g.accounts.map((a) => (
                      <li key={a.code}>
                        <label className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-50 ${a.parent ? "pl-5" : ""}`}>
                          <input type="checkbox" checked={on.has(a.code)} onChange={(e) => set([a.code], e.target.checked)} />
                          <span className="text-xs text-gray-400 tabular-nums">{a.code}</span>
                          <span>{fullName(accounts, a)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
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

/**
 * 打って探せる科目の欄：「syu」「しゅ」「744」などと打つと、コード・名前・読みが合う科目だけを出す。
 * ↑↓で選び、Enter で決める。何も打たなければ、ふだんの科目（only）を区分ごとに出す。
 * only にない科目も、打った言葉に合えば「ほかの科目」として下に出す
 */
export function AccountCombo({
  accounts,
  value,
  onChange,
  label,
  empty,
  only,
  className = "",
}: {
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  label: string;
  empty?: string;
  only?: string[];
  className?: string;
}) {
  const [open, setOpen] = useState<{ top: number; left: number; width: number } | null>(null);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const base = accounts.filter((a) => !a.hidden);
  const usual = only && only.length ? base.filter((a) => only.includes(a.code)) : base;
  // 打った言葉で始まる科目を上に
  const ranked = (list: Account[]) =>
    list
      .map((a) => ({ a, r: rankAccount(accounts, a, q) }))
      .filter((x) => x.r >= 0)
      .sort((x, y) => x.r - y.r)
      .map((x) => x.a);
  const hit = q ? ranked(usual) : usual;
  const others = q && usual !== base ? ranked(base.filter((a) => !usual.includes(a))) : [];
  // 選べる順：空にする → ふだんの科目 → ほかの科目
  const options: (Account | null)[] = [null, ...hit, ...others];
  const current = value ? accounts.find((a) => a.code === value) : undefined;
  const text = value ? (current ? `${current.code} ${fullName(accounts, current)}` : `（未登録 ${value}）`) : (empty ?? "（科目を選ぶ）");
  const choose = (a: Account | null) => {
    onChange(a ? a.code : "");
    setOpen(null);
    setQ("");
  };
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 300;
    setOpen({ top: below ? r.bottom + 2 : Math.max(8, r.top - 302), left: Math.min(r.left, window.innerWidth - 340), width: Math.max(r.width, 320) });
    setHi(0);
  };
  const row = (a: Account | null, i: number) => (
    <li key={a ? a.code : "-"}>
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          choose(a);
        }}
        onMouseEnter={() => setHi(i)}
        className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${i === hi ? "bg-berry/10" : ""} ${a?.parent ? "pl-5" : ""}`}
      >
        {a ? (
          <>
            <span className="text-xs text-gray-400 tabular-nums">{a.code}</span>
            <span>{fullName(accounts, a)}</span>
          </>
        ) : (
          <span className="text-gray-500">{empty ?? "（科目を選ぶ）"}</span>
        )}
      </button>
    </li>
  );
  return (
    <>
      <input
        value={open ? q : text}
        aria-label={label}
        placeholder={text}
        onFocus={(e) => {
          setQ("");
          show(e.currentTarget);
        }}
        onBlur={() => {
          setOpen(null);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(e.target.value ? 1 : 0);
          if (!open) show(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi(Math.min(hi + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi(Math.max(hi - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (options[hi] !== undefined) choose(options[hi]);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setOpen(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`rounded border bg-white px-2 py-1 ${className}`}
      />
      {open && (
        <ul style={{ top: open.top, left: open.left, width: open.width }} className="fixed z-50 max-h-72 overflow-auto rounded-xl border bg-white py-1 text-sm shadow-xl">
          {row(null, 0)}
          {q
            ? hit.map((a, i) => row(a, i + 1))
            : accountGroups(hit).flatMap((g) => [
                <li key={`g-${g.label}`} className="sticky top-0 bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                  {g.label}
                </li>,
                ...g.accounts.map((a) => row(a, hit.indexOf(a) + 1)),
              ])}
          {others.length > 0 && <li className="bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">ほかの科目</li>}
          {others.map((a, i) => row(a, hit.length + 1 + i))}
          {q && hit.length + others.length === 0 && <li className="px-2 py-2 text-xs text-gray-500">見つかりません</li>}
        </ul>
      )}
    </>
  );
}
