"use client";

// 帳簿：仕訳帳（月ごと）。
// 現金出納帳の出入りは、勘定科目の画面で決めた科目で自動で仕訳になる（ここでは直せない。出納帳で直す）。
// 預金・売掛・給与・減価償却など、現金以外の取引は、ここで1行ずつ手で入れる（管理者と経理担当）
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import {
  accountOf,
  buildSuggester,
  taxOf,
  fullName,
  autoPostings,
  importedPostings,
  bankPostings,
  cashPostings,
  emptyJournal,
  isBlankJournal,
  isUnsortedJournal,
  journalProblem,
  saveJournalMonth,
  saveLedgerConfig,
  UNSORTED,
  useBooks,
  useLedgerConfig,
  type JournalEntry,
  type AutoMonth,
  type Books,
  type JournalMonth,
  type Suggestion,
  type Posting,
  type LedgerConfig,
} from "@/lib/books";
import { reiwa } from "@/lib/payroll";
import { downloadXlsx, type XCell } from "@/lib/xlsxWrite";
import { AccountSelect, Amount, canUseLedger, LedgerHeader, PickFilter, yen } from "./parts";

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
  const { value: books, error: e1 } = useBooks();
  const { value: config, error: e3 } = useLedgerConfig();
  const [y, m] = month.split("-").map(Number);

  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e3;
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
      ) : !books || !config ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Editor key={month} month={month} books={books} config={config} />
      )}
    </div>
  );
}

function Editor({ month, books, config }: { month: string; books: Books; config: LedgerConfig }) {
  const today = todayJST();
  const defaultDate = today.startsWith(month) ? today : `${month}-01`;
  const saved = books.journal.find((x) => x.month === month)?.entries ?? [];
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
  const name = (code: string) => fullName(accounts, accountOf(accounts, code));
  const fromCash = cashPostings(books.cash, month, config.itemMap);
  const fromAuto = autoPostings(books.auto, month);
  const fromBank = bankPostings(books.bank, month, config.bankRules);
  const imported = books.imported.some((x) => x.month === month) ? importedPostings(books.imported, month, accounts) : null;
  const change = (next: JournalEntry[]) => {
    // 次の空の行は、直前の行と同じ日付にしておく（続けて入れやすいように）
    const body = next.filter((e) => !isBlankJournal(e));
    setEntries(withBlankRow(next, body.length ? body[body.length - 1].date || defaultDate : defaultDate));
    setDirty(true);
    setMsg("");
  };
  const set = (i: number, p: Partial<JournalEntry>) => change(entries.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const problems = entries.map((e) => journalProblem(e, month));
  const unsortedCount = entries.filter(isUnsortedJournal).length;
  // 候補：これまでに仕分けた行（保存したもの）から、品名・取引先ごとの科目を覚える
  const suggest = useMemo(() => buildSuggester(books.journal), [books.journal]);
  const candidates = entries.map((e) => (isUnsortedJournal(e) || (!isBlankJournal(e) && (!e.debit || !e.credit)) ? suggest(e) : null));
  const canApply = entries.filter((e, i) => candidates[i] && (!e.debit || !e.credit)).length;
  const applyAll = () =>
    change(
      entries.map((e, i) => {
        const c = candidates[i];
        if (!c) return e;
        if (!e.debit && e.credit !== c.code) return { ...e, debit: c.code };
        if (!e.credit && e.debit !== c.code) return { ...e, credit: c.code };
        return e;
      }),
    );
  /** 税率の欄が空のとき：科目の税率（収益・費用の側） */
  const rateLabel = (e: JournalEntry) => {
    const a = [e.debit, e.credit].map((c) => (c ? accountOf(accounts, c) : null)).find((a) => a && (a.kind === "revenue" || a.kind === "expense"));
    return a ? `科目(${taxOf(a) ? `${taxOf(a)}%` : "なし"})` : "—";
  };
  const [onlyUnsorted, setOnlyUnsorted] = useState(false);
  const [allAccounts, setAllAccounts] = useState(false);
  /** プルダウンに出す科目を、その場で保存する */
  const savePick = (pick: string[]) => {
    setAllAccounts(false);
    saveLedgerConfig({ ...config, pick }).catch((e) => setErr(errorText(e)));
  };
  const hasProblem = problems.some(Boolean);
  const manualTotal = entries.reduce((n, e) => n + (isBlankJournal(e) ? 0 : (e.amount ?? 0)), 0);
  const autoAll = [...fromAuto, ...fromBank, ...fromCash];
  const autoTotal = autoAll.reduce((n, p) => n + p.amount, 0);

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
    const rateOf = (p: { tax?: number | null; debit: string; credit: string }) => {
      if (typeof p.tax === "number") return p.tax ? `${p.tax}%` : "なし";
      const a = [p.debit, p.credit].map((c) => (c ? accountOf(accounts, c) : null)).find((a) => a && (a.kind === "revenue" || a.kind === "expense"));
      return a ? (taxOf(a) ? `${taxOf(a)}%` : "なし") : "";
    };
    const all = [
      ...autoAll.map((p) => ({ ...p, memo2: p.memo2 ?? "", from: p.source === "cash" ? "出納帳" : p.source === "bank" ? "通帳" : "自動" })),
      ...entries
        .filter((e) => !isBlankJournal(e))
        .map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: e.amount ?? 0, tax: e.tax, memo: e.memo, memo2: e.memo2 ?? "", from: isUnsortedJournal(e) ? "未仕分け" : "" })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const rows: XCell[][] = [
      [{ v: "仕訳帳", bold: true }, null, month],
      [],
      ["日付", "借方科目", "貸方科目", "金額", "税率", "摘要（品名）", "摘要（取引先）", "元"].map((h) => B(h)),
      ...all.map((p) => [
        B(md(p.date)),
        B(p.debit ? name(p.debit) : "", { left: true }),
        B(p.credit ? name(p.credit) : "", { left: true }),
        B(p.amount, { num: true }),
        B(rateOf(p)),
        B(p.memo, { left: true }),
        B(p.memo2, { left: true }),
        B(p.from),
      ]),
      [B("合計", { bold: true }), B(null), B(null), B(autoTotal + manualTotal, { num: true, bold: true }), B(null), B(null), B(null), B(null)],
    ];
    downloadXlsx(`journal_${month}.xlsx`, month, rows, [8, 18, 18, 12, 7, 30, 24, 9]);
  }


  return (
    <>
      {imported && (
        <section className="mt-4 rounded-2xl border-2 border-sky-300 bg-sky-50 p-4">
          <h2 className="font-bold">この月は、会計ソフトから取り込んだ試算表の数字を使っています</h2>
          <p className="mt-1 text-xs text-gray-600">
            決算書・元帳には、下の試算表の数字と、手で入れる仕訳（仕分けし直しの振替など）が入ります。レジ・給与・通帳・出納帳からの仕訳は、この月は数えません（試算表にもう入っているため）。
            <Link href="/staff/ledger/import/" className="ml-1 underline">
              取り込みの画面
            </Link>
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-sky-800 underline">試算表の数字を見る（{imported.length}行）</summary>
            <PostingTable postings={imported} name={name} empty="" />
          </details>
        </section>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={exportExcel} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm text-emerald-800">
          ⬇ エクセルで書き出す
        </button>
      </div>

      <UnsortedMonths journal={books.journal} month={month} />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h2 className="font-bold">手で入れる仕訳</h2>
        {unsortedCount > 0 && (
          <>
            <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-900">この月の未仕分け {unsortedCount}行</span>
            {canApply > 0 && (
              <button onClick={applyAll} className="rounded-lg border border-amber-500 bg-white px-3 py-1 text-sm text-amber-900">
                候補をまとめてあてる（{canApply}行）
              </button>
            )}
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={onlyUnsorted} onChange={(x) => setOnlyUnsorted(x.target.checked)} />
              未仕分けだけ出す
            </label>
          </>
        )}
        {config.pick.length > 0 && (
          <label className="flex items-center gap-1 text-sm print:hidden">
            <input type="checkbox" checked={allAccounts} onChange={(x) => setAllAccounts(x.target.checked)} />
            科目を全部出す
            <span className="text-xs text-gray-500">
              （ふだんは
              <Link href="/staff/ledger/accounts/" className="underline">
                勘定科目
              </Link>
              で選んだ{config.pick.length}科目だけ）
            </span>
          </label>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        預金の出し入れ・売上の入金・給与・借入の返済など、現金出納帳にない取引を入れます。例：売上が預金に入った → 借方「普通預金」／貸方「売上高」
      </p>
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[72rem] text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="w-36 px-2 py-2 text-left">日付</th>
              <th className="px-2 py-2 text-left">
                借方（増えた資産・かかった費用）
                <PickFilter accounts={accounts} pick={config.pick} onChange={savePick} />
              </th>
              <th className="px-2 py-2 text-left">
                貸方（減った資産・入った収益）
                <PickFilter accounts={accounts} pick={config.pick} onChange={savePick} />
              </th>
              <th className="w-28 px-2 py-2 text-right">金額</th>
              <th className="w-20 px-2 py-2 text-left">税率</th>
              <th className="px-2 py-2 text-left">摘要（品名）</th>
              <th className="px-2 py-2 text-left">摘要（取引先）</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) =>
              onlyUnsorted && !isUnsortedJournal(e) && !isBlankJournal(e) ? null : (
              <tr key={i} className={`border-t ${problems[i] ? "bg-red-50" : isUnsortedJournal(e) ? "bg-amber-50" : ""}`}>
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
                  <AccountSelect
                    accounts={accounts}
                    value={e.debit}
                    onChange={(v) => set(i, { debit: v })}
                    label={`${i + 1}行目の借方`}
                    only={allAccounts ? undefined : config.pick}
                    empty={isUnsortedJournal(e) ? "（未仕分け）" : undefined}
                    className={`w-full ${isUnsortedJournal(e) && !e.debit ? "border-amber-400 font-bold text-amber-800" : ""}`}
                  />
                  <Candidate e={e} side="debit" suggest={suggest} name={name} onPick={(code) => set(i, { debit: code })} />
                </td>
                <td className="px-1 py-1 align-top">
                  <AccountSelect
                    accounts={accounts}
                    value={e.credit}
                    onChange={(v) => set(i, { credit: v })}
                    label={`${i + 1}行目の貸方`}
                    only={allAccounts ? undefined : config.pick}
                    empty={isUnsortedJournal(e) ? "（未仕分け）" : undefined}
                    className={`w-full ${isUnsortedJournal(e) && !e.credit ? "border-amber-400 font-bold text-amber-800" : ""}`}
                  />
                  <Candidate e={e} side="credit" suggest={suggest} name={name} onPick={(code) => set(i, { credit: code })} />
                </td>
                <td className="px-1 py-1 align-top">
                  <Amount value={e.amount} onChange={(v) => set(i, { amount: v })} label={`${i + 1}行目の金額`} />
                </td>
                <td className="px-1 py-1 align-top">
                  <select
                    value={typeof e.tax === "number" ? String(e.tax) : ""}
                    aria-label={`${i + 1}行目の税率`}
                    onChange={(x) => set(i, { tax: x.target.value === "" ? null : Number(x.target.value) })}
                    className="w-full rounded border bg-white px-1 py-1"
                    title="空なら科目の税率"
                  >
                    <option value="">{rateLabel(e)}</option>
                    <option value="10">10%</option>
                    <option value="8">8%</option>
                    <option value="0">なし</option>
                  </select>
                </td>
                <td className="px-1 py-1 align-top">
                  <input
                    value={e.memo}
                    maxLength={80}
                    aria-label={`${i + 1}行目の摘要（品名）`}
                    onChange={(x) => set(i, { memo: x.target.value })}
                    className="w-full rounded border px-2 py-1"
                  />
                  {e.src && <p className="mt-0.5 text-xs text-gray-400">{e.src}</p>}
                  {problems[i] && <p className="mt-0.5 text-xs text-red-600">{problems[i]}</p>}
                </td>
                <td className="px-1 py-1 align-top">
                  <input
                    value={e.memo2 ?? ""}
                    maxLength={60}
                    aria-label={`${i + 1}行目の摘要（取引先）`}
                    onChange={(x) => set(i, { memo2: x.target.value })}
                    className="w-full rounded border px-2 py-1"
                  />
                </td>
                <td className="px-1 text-center align-top">
                  {!isBlankJournal(e) && (
                    <button onClick={() => change(entries.filter((_, j) => j !== i))} className="px-1 py-1 text-gray-400 hover:text-red-600" aria-label={`${i + 1}行目を消す`}>
                      🗑
                    </button>
                  )}
                </td>
              </tr>
              ),
            )}
          </tbody>
          <tfoot className="border-t-2 bg-gray-50 font-bold">
            <tr>
              <td colSpan={3} className="px-2 py-2">
                合計
              </td>
              <td className="px-2 text-right tabular-nums">{yen(manualTotal)}</td>
              <td colSpan={4} />
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

      <AutoSection month={month} auto={books.auto.find((x) => x.month === month)} postings={fromAuto} name={name} />

      <h2 className="mt-8 font-bold">預金通帳からの仕訳（自動）</h2>
      <p className="mt-1 text-xs text-gray-500">
        <Link href={`/staff/ledger/bank/?month=${month}`} className="underline">
          預金通帳
        </Link>
        の画面で取り込んだ入出金です。科目は摘要の言葉で決まります。
      </p>
      <Unsorted count={fromBank.filter(isUnsorted).length} href={`/staff/ledger/bank/?month=${month}`} />
      <PostingTable postings={fromBank} name={name} empty="この月の通帳の取り込みはありません。" />

      <h2 className="mt-8 font-bold">現金出納帳からの仕訳（自動）</h2>
      <p className="mt-1 text-xs text-gray-500">
        出納帳の「項目」ごとに、
        <Link href="/staff/ledger/accounts/" className="underline">
          勘定科目
        </Link>
        の画面で決めた科目で仕訳にしています。直すときは出納帳か、科目の対応を直してください。
      </p>
      <Unsorted count={fromCash.filter(isUnsorted).length} href="/staff/ledger/accounts/" />
      <PostingTable postings={fromCash} name={name} empty="この月の現金出納帳はありません。" />
    </>
  );
}

const isUnsorted = (p: Posting) => p.debit === UNSORTED || p.credit === UNSORTED;

function Unsorted({ count, href }: { count: number; href: string }) {
  if (!count) return null;
  return (
    <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
      科目が決まっていない行が {count} 行あります（「未分類」になっています）。
      <Link href={href} className="ml-1 font-bold underline">
        科目を決める
      </Link>
    </p>
  );
}

/** レジの売上・売掛・給与からの仕訳。開いたときに、その月の分を作り直す（売上や給与が変わっていても合うように） */
function AutoSection({ month, auto, postings, name }: { month: string; auto: AutoMonth | undefined; postings: Posting[]; name: (c: string) => string }) {
  const future = month > todayJST().slice(0, 7);
  const [busy, setBusy] = useState(!future);
  const [err, setErr] = useState("");
  async function run() {
    setErr("");
    setBusy(true);
    try {
      await callFunction("buildAutoJournal", { month });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (future) return;
    callFunction("buildAutoJournal", { month })
      .catch((e) => setErr(errorText(e)))
      .finally(() => setBusy(false));
  }, [month, future]);
  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <h2 className="font-bold">レジの売上・売掛・給与からの仕訳（自動）</h2>
        <button onClick={run} disabled={busy} className="rounded-lg border border-berry bg-white px-3 py-1 text-sm text-berry disabled:opacity-50 print:hidden">
          {busy ? "作っています…" : "🔄 作り直す"}
        </button>
        {auto?.generatedAt && !busy && (
          <span className="text-xs text-gray-500">
            {auto.generatedAt.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} に作成
          </span>
        )}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        レジの会計（現金・売掛）、売掛管理（手で入れた売掛・入金）、給与（支給日の月）から作ります。ホーブへの出荷は、入金のときに通帳の取り込みで売上（野菜等収入／イチゴ）になります。使う科目は
        <Link href="/staff/ledger/accounts/" className="underline">
          勘定科目
        </Link>
        の画面で変えられます。
      </p>
      <PostingTable postings={postings} name={name} empty={busy ? "作っています…" : "この月のレジの売上・給与はありません。"} />
    </>
  );
}

function PostingTable({ postings, name, empty }: { postings: Posting[]; name: (c: string) => string; empty: string }) {
  if (postings.length === 0) return <p className="mt-2 text-sm text-gray-500">{empty}</p>;
  const total = postings.reduce((n, p) => n + p.amount, 0);
  return (
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
          {postings.map((p, i) => (
            <tr key={i} className={`border-t ${isUnsorted(p) ? "bg-amber-50" : ""}`}>
              <td className="px-2 py-1.5">{md(p.date)}</td>
              <td className={`px-2 ${p.debit === UNSORTED ? "font-bold text-amber-700" : ""}`}>{name(p.debit)}</td>
              <td className={`px-2 ${p.credit === UNSORTED ? "font-bold text-amber-700" : ""}`}>{name(p.credit)}</td>
              <td className="px-2 text-right">{yen(p.amount)}</td>
              <td className="px-2 py-1.5">
                {p.memo}
                {p.memo2 && <span className="ml-1 text-xs text-gray-500">{p.memo2}</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 bg-gray-50 font-bold">
          <tr>
            <td colSpan={3} className="px-2 py-2">
              合計
            </td>
            <td className="px-2 text-right">{yen(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** 未仕分けの行がある月（仕分けし直しの途中）。月を押すとその月を開く */
function UnsortedMonths({ journal, month }: { journal: JournalMonth[]; month: string }) {
  const list = journal.map((m) => ({ month: m.month, count: m.entries.filter(isUnsortedJournal).length })).filter((x) => x.count > 0);
  if (list.length === 0) return null;
  const total = list.reduce((n, x) => n + x.count, 0);
  return (
    <section className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm print:hidden">
      <p className="font-bold text-amber-900">仕分けし直しの途中：未仕分けが {total}行あります</p>
      <p className="mt-0.5 text-xs text-amber-900">借方に新しい科目を選んで保存すると、元の科目からその科目へ移ります。決まるまでは、帳簿は元の科目のままです。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {list.map((x) => (
          <Link
            key={x.month}
            href={`/staff/ledger/?month=${x.month}`}
            className={`rounded-lg border px-3 py-1 ${x.month === month ? "border-amber-600 bg-amber-600 font-bold text-white" : "border-amber-400 bg-white text-amber-900"}`}
          >
            {Number(x.month.slice(5))}月 {x.count}行
          </Link>
        ))}
      </div>
    </section>
  );
}

/** 空いている側の科目の候補（押すとその科目にする） */
function Candidate({
  e,
  side,
  suggest,
  name,
  onPick,
}: {
  e: JournalEntry;
  side: "debit" | "credit";
  suggest: (e: JournalEntry) => Suggestion | null;
  name: (code: string) => string;
  onPick: (code: string) => void;
}) {
  if (e[side] || isBlankJournal(e)) return null;
  const c = suggest(e);
  const other = side === "debit" ? e.credit : e.debit;
  if (!c || c.code === other) return null;
  return (
    <button onClick={() => onPick(c.code)} className="mt-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-left text-xs text-sky-800 hover:bg-sky-200" title={`同じ${c.by}で前に選んだ科目`}>
      候補：{name(c.code)}（{c.by}）
    </button>
  );
}
