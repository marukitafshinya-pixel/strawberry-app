"use client";

// 帳簿：仕訳帳（月ごと）。
// 現金出納帳の出入りは、勘定科目の画面で決めた科目で自動で仕訳になる（ここでは直せない。出納帳で直す）。
// 預金・売掛・給与・減価償却など、現金以外の取引は、ここで1行ずつ手で入れる（管理者と経理担当）
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { useCashbook, type CashMonth } from "@/lib/cashbook";
import { shiftMonth, todayJST } from "@/lib/date";
import {
  accountOf,
  cashPostings,
  emptyJournal,
  isBlankJournal,
  journalProblem,
  saveJournalMonth,
  UNSORTED,
  useJournal,
  useLedgerConfig,
  type JournalEntry,
  type JournalMonth,
  type LedgerConfig,
} from "@/lib/ledger";
import { reiwa } from "@/lib/payroll";
import { downloadXlsx, type XCell } from "@/lib/xlsxWrite";
import { AccountSelect, Amount, canUseLedger, LedgerHeader, yen } from "./parts";

const withBlankRow = (list: JournalEntry[], date: string): JournalEntry[] =>
  list.length === 0 || !isBlankJournal(list[list.length - 1]) ? [...list, emptyJournal(date)] : list;
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).toISOString().slice(0, 10);
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export default function JournalPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <JournalView />
    </Suspense>
  );
}

function JournalView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/ledger/?month=${m}`);
  const { value: cash, error: e1 } = useCashbook();
  const { value: journal, error: e2 } = useJournal();
  const { value: config, error: e3 } = useLedgerConfig();
  const [y, m] = month.split("-").map(Number);

  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2 || e3;
  return (
    <div className="pb-24">
      <LedgerHeader title="仕訳帳" />
      <div className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="text-lg font-bold">
          {reiwa(y)} {m}月
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
        <input
          type="month"
          value={month}
          onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)}
          className="rounded-lg border px-2 py-1.5"
        />
      </div>
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !cash || !journal || !config ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Editor key={month} month={month} cash={cash} journal={journal} config={config} />
      )}
    </div>
  );
}

function Editor({ month, cash, journal, config }: { month: string; cash: CashMonth[]; journal: JournalMonth[]; config: LedgerConfig }) {
  const today = todayJST();
  const defaultDate = today.startsWith(month) ? today : `${month}-01`;
  const saved = journal.find((x) => x.month === month)?.entries ?? [];
  const [entries, setEntries] = useState<JournalEntry[]>(() => withBlankRow(saved, defaultDate));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const { accounts } = config;
  const name = (code: string) => accountOf(accounts, code).name;
  const fromCash = cashPostings(cash, month, config.itemMap);
  const unsorted = fromCash.filter((p) => p.debit === UNSORTED || p.credit === UNSORTED);
  const change = (next: JournalEntry[]) => {
    // 次の空の行は、直前の行と同じ日付にしておく（続けて入れやすいように）
    const body = next.filter((e) => !isBlankJournal(e));
    setEntries(withBlankRow(next, body.length ? body[body.length - 1].date || defaultDate : defaultDate));
    setDirty(true);
    setMsg("");
  };
  const set = (i: number, p: Partial<JournalEntry>) => change(entries.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const problems = entries.map((e) => journalProblem(e, month));
  const hasProblem = problems.some(Boolean);
  const manualTotal = entries.reduce((n, e) => n + (isBlankJournal(e) ? 0 : (e.amount ?? 0)), 0);
  const cashTotal = fromCash.reduce((n, p) => n + p.amount, 0);

  async function save() {
    setErr("");
    if (hasProblem) return setErr("赤く出ている行を直してから保存してください");
    setSaving(true);
    try {
      await saveJournalMonth(month, entries);
      setDirty(false);
      setMsg("保存しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function exportExcel() {
    const B = (v: string | number | null, o: { num?: boolean; bold?: boolean; left?: boolean } = {}): XCell => ({ v, border: true, ...o });
    const all = [
      ...fromCash.map((p) => ({ ...p, from: "出納帳" })),
      ...entries.filter((e) => !isBlankJournal(e)).map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: e.amount ?? 0, memo: e.memo, from: "" })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const rows: XCell[][] = [
      [{ v: "仕訳帳", bold: true }, null, month],
      [],
      ["日付", "借方科目", "貸方科目", "金額", "摘要", "元"].map((h) => B(h)),
      ...all.map((p) => [B(md(p.date)), B(name(p.debit), { left: true }), B(name(p.credit), { left: true }), B(p.amount, { num: true }), B(p.memo, { left: true }), B(p.from)]),
      [B("合計", { bold: true }), B(null), B(null), B(cashTotal + manualTotal, { num: true, bold: true }), B(null), B(null)],
    ];
    downloadXlsx(`journal_${month}.xlsx`, month, rows, [8, 16, 16, 12, 40, 8]);
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={exportExcel} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm text-emerald-800">
          ⬇ エクセルで書き出す
        </button>
      </div>

      <h2 className="mt-6 font-bold">手で入れる仕訳</h2>
      <p className="mt-1 text-xs text-gray-500">
        預金の出し入れ・売上の入金・給与・借入の返済など、現金出納帳にない取引を入れます。例：売上が預金に入った → 借方「普通預金」／貸方「売上高」
      </p>
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="w-36 px-2 py-2 text-left">日付</th>
              <th className="px-2 py-2 text-left">借方（増えた資産・かかった費用）</th>
              <th className="px-2 py-2 text-left">貸方（減った資産・入った収益）</th>
              <th className="w-32 px-2 py-2 text-right">金額</th>
              <th className="px-2 py-2 text-left">摘要</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className={`border-t ${problems[i] ? "bg-red-50" : ""}`}>
                <td className="px-1 py-1 align-top">
                  <input
                    type="date"
                    value={e.date}
                    min={`${month}-01`}
                    max={lastDay(month)}
                    aria-label={`${i + 1}行目の日付`}
                    onChange={(x) => set(i, { date: x.target.value })}
                    className="w-full rounded border px-1 py-1"
                  />
                </td>
                <td className="px-1 py-1 align-top">
                  <AccountSelect accounts={accounts} value={e.debit} onChange={(v) => set(i, { debit: v })} label={`${i + 1}行目の借方`} className="w-full" />
                </td>
                <td className="px-1 py-1 align-top">
                  <AccountSelect accounts={accounts} value={e.credit} onChange={(v) => set(i, { credit: v })} label={`${i + 1}行目の貸方`} className="w-full" />
                </td>
                <td className="px-1 py-1 align-top">
                  <Amount value={e.amount} onChange={(v) => set(i, { amount: v })} label={`${i + 1}行目の金額`} />
                </td>
                <td className="px-1 py-1 align-top">
                  <input
                    value={e.memo}
                    maxLength={80}
                    aria-label={`${i + 1}行目の摘要`}
                    onChange={(x) => set(i, { memo: x.target.value })}
                    className="w-full rounded border px-2 py-1"
                  />
                  {problems[i] && <p className="mt-0.5 text-xs text-red-600">{problems[i]}</p>}
                </td>
                <td className="px-1 text-center align-top">
                  {!isBlankJournal(e) && (
                    <button onClick={() => change(entries.filter((_, j) => j !== i))} className="px-1 py-1 text-gray-400 hover:text-red-600" aria-label={`${i + 1}行目を消す`}>
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-gray-50 font-bold">
            <tr>
              <td colSpan={3} className="px-2 py-2">
                合計
              </td>
              <td className="px-2 text-right tabular-nums">{yen(manualTotal)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-3 border-t bg-gray-50/95 py-3">
        <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "保存する"}
        </button>
        {dirty && <span className="text-sm text-amber-700">保存していない変更があります</span>}
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>

      <h2 className="mt-8 font-bold">現金出納帳からの仕訳（自動）</h2>
      <p className="mt-1 text-xs text-gray-500">
        出納帳の「項目」ごとに、
        <Link href="/staff/ledger/accounts/" className="underline">
          勘定科目
        </Link>
        の画面で決めた科目で仕訳にしています。直すときは出納帳か、科目の対応を直してください。
      </p>
      {unsorted.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          科目が決まっていない項目が {unsorted.length} 行あります（「未分類」になっています）。
          <Link href="/staff/ledger/accounts/" className="ml-1 font-bold underline">
            科目を決める
          </Link>
        </p>
      )}
      {fromCash.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">この月の現金出納帳はありません。</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-[44rem] text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="w-16 px-2 py-2 text-left">日付</th>
                <th className="px-2 py-2 text-left">借方</th>
                <th className="px-2 py-2 text-left">貸方</th>
                <th className="w-28 px-2 py-2 text-right">金額</th>
                <th className="px-2 py-2 text-left">摘要</th>
              </tr>
            </thead>
            <tbody>
              {fromCash.map((p, i) => {
                const bad = p.debit === UNSORTED || p.credit === UNSORTED;
                return (
                  <tr key={i} className={`border-t ${bad ? "bg-amber-50" : ""}`}>
                    <td className="px-2 py-1.5">{md(p.date)}</td>
                    <td className={`px-2 ${p.debit === UNSORTED ? "font-bold text-amber-700" : ""}`}>{name(p.debit)}</td>
                    <td className={`px-2 ${p.credit === UNSORTED ? "font-bold text-amber-700" : ""}`}>{name(p.credit)}</td>
                    <td className="px-2 text-right">{yen(p.amount)}</td>
                    <td className="px-2 py-1.5">{p.memo}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t-2 bg-gray-50 font-bold">
              <tr>
                <td colSpan={3} className="px-2 py-2">
                  合計
                </td>
                <td className="px-2 text-right">{yen(cashTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
