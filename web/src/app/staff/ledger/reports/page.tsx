"use client";

// 帳簿：決算書・元帳。期（会計年度）ごとに、損益計算書（月別）・貸借対照表・試算表・総勘定元帳を出す
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { useCashbook, type CashMonth } from "@/lib/cashbook";
import { shiftMonth, todayJST } from "@/lib/date";
import {
  accountOf,
  buildPeriod,
  CASH,
  fiscalLabel,
  fiscalMonths,
  fiscalStartOf,
  KIND_LABEL,
  ledgerOf,
  monthlyAmounts,
  monthsWithData,
  UNSORTED,
  useJournal,
  useLedgerConfig,
  type Account,
  type AccountKind,
  type JournalMonth,
  type LedgerConfig,
} from "@/lib/ledger";
import { downloadXlsx, type XCell } from "@/lib/xlsxWrite";
import { canUseLedger, LedgerHeader, yen } from "../parts";

type Tab = "pl" | "bs" | "tb" | "gl";
const TABS: { key: Tab; label: string }[] = [
  { key: "pl", label: "損益計算書" },
  { key: "bs", label: "貸借対照表" },
  { key: "tb", label: "試算表" },
  { key: "gl", label: "総勘定元帳" },
];
const mo = (ym: string) => `${Number(ym.slice(5))}月`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const B = (v: string | number | null, o: { num?: boolean; bold?: boolean; left?: boolean } = {}): XCell => ({ v, border: true, ...o });

export default function ReportsPage() {
  const { role } = useAuth();
  const { value: cash, error: e1 } = useCashbook();
  const { value: journal, error: e2 } = useJournal();
  const { value: config, error: e3 } = useLedgerConfig();
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2 || e3;
  return (
    <div className="pb-24">
      <LedgerHeader title="決算書・元帳" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !cash || !journal || !config ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Reports cash={cash} journal={journal} config={config} />
      )}
    </div>
  );
}

function Reports({ cash, journal, config }: { cash: CashMonth[]; journal: JournalMonth[]; config: LedgerConfig }) {
  const thisMonth = todayJST().slice(0, 7);
  const [start, setStart] = useState(() => fiscalStartOf(thisMonth, config.fiscalStart));
  // 決算月を変えたら、期のはじまりも合わせる
  const fixedStart = fiscalStartOf(start, config.fiscalStart);
  const months = fiscalMonths(fixedStart);
  /** 期の途中までで見る（その月まで） */
  const [upTo, setUpTo] = useState<string>("");
  const end = upTo && months.includes(upTo) ? upTo : months[11];
  const [tab, setTab] = useState<Tab>("pl");
  const [glCode, setGlCode] = useState(CASH);

  const period = buildPeriod(cash, journal, config, fixedStart, end);
  const unsorted = period.during.filter((p) => p.debit === UNSORTED || p.credit === UNSORTED).length;
  // 選べる期：データのある期と、いまの期
  const starts = [...new Set([...monthsWithData(cash, journal), thisMonth].map((m) => fiscalStartOf(m, config.fiscalStart)))].sort().reverse();
  const title = `${fiscalLabel(fixedStart)}${end !== months[11] ? `（${mo(end)}まで）` : ""}`;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setStart(shiftMonth(fixedStart, -12))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前の期
        </button>
        <select value={fixedStart} onChange={(e) => setStart(e.target.value)} className="rounded-lg border bg-white px-2 py-2 font-bold">
          {[...new Set([fixedStart, ...starts])].sort().reverse().map((s) => (
            <option key={s} value={s}>
              {fiscalLabel(s)}
            </option>
          ))}
        </select>
        <button onClick={() => setStart(shiftMonth(fixedStart, 12))} className="rounded-lg border bg-white px-3 py-2">
          次の期 ›
        </button>
        <label className="ml-2 flex items-center gap-1 text-sm">
          <select value={end} onChange={(e) => setUpTo(e.target.value)} className="rounded border bg-white px-2 py-1.5">
            {months.map((m) => (
              <option key={m} value={m}>
                {m.slice(0, 4)}年{mo(m)}
              </option>
            ))}
          </select>
          まで
        </label>
        <span className="flex-1" />
        <button onClick={() => window.print()} className="rounded-lg border bg-white px-3 py-2 text-sm">
          🖨 印刷
        </button>
      </div>
      {unsorted > 0 && (
        <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 print:hidden">
          この期に、科目が決まっていない出納帳の行が {unsorted} 行あります（「未分類」の費用として数えています）。
          <Link href="/staff/ledger/accounts/" className="ml-1 font-bold underline">
            科目を決める
          </Link>
        </p>
      )}
      <nav className="mt-4 flex flex-wrap gap-1 border-b print:hidden">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px rounded-t-lg border px-4 py-2 text-sm font-bold ${tab === t.key ? "border-b-white bg-white text-berry" : "border-transparent text-gray-500"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="mt-4">
        {tab === "pl" && <ProfitLoss cash={cash} journal={journal} config={config} months={months.filter((m) => m <= end)} title={title} />}
        {tab === "bs" && <BalanceSheet period={period} title={title} />}
        {tab === "tb" && <TrialBalance period={period} title={title} />}
        {tab === "gl" && <GeneralLedger period={period} accounts={config.accounts} code={glCode} setCode={setGlCode} title={title} />}
      </div>
    </>
  );
}

type Period = ReturnType<typeof buildPeriod>;

function ExcelButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm text-emerald-800 print:hidden">
      ⬇ エクセルで書き出す
    </button>
  );
}

function Heading({ name, title, onExcel }: { name: string; title: string; onExcel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-bold">
        {name}　<span className="text-sm font-normal text-gray-600">{title}</span>
      </h2>
      <span className="flex-1" />
      <ExcelButton onClick={onExcel} />
    </div>
  );
}

/** 損益計算書：収益・費用の科目ごとに、月別と期の合計 */
function ProfitLoss({ cash, journal, config, months, title }: { cash: CashMonth[]; journal: JournalMonth[]; config: LedgerConfig; months: string[]; title: string }) {
  const byMonth = monthlyAmounts(cash, journal, config, months);
  const codesOf = (kind: AccountKind) =>
    [...new Set(byMonth.flatMap((m) => [...m.keys()]))]
      .map((c) => accountOf(config.accounts, c))
      .filter((a) => a.kind === kind && byMonth.some((m) => m.get(a.code)))
      .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true }));
  const revenue = codesOf("revenue");
  const expense = codesOf("expense");
  const sumOf = (list: Account[], i: number) => list.reduce((n, a) => n + (byMonth[i].get(a.code) ?? 0), 0);
  const total = (f: (i: number) => number) => months.reduce((n, _, i) => n + f(i), 0);
  const profit = (i: number) => sumOf(revenue, i) - sumOf(expense, i);
  const lines: { label: string; values: (i: number) => number; strong?: boolean; head?: boolean }[] = [
    { label: "【収益】", values: () => 0, head: true },
    ...revenue.map((a) => ({ label: a.name, values: (i: number) => byMonth[i].get(a.code) ?? 0 })),
    { label: "収益の合計", values: (i: number) => sumOf(revenue, i), strong: true },
    { label: "【費用】", values: () => 0, head: true },
    ...expense.map((a) => ({ label: a.name, values: (i: number) => byMonth[i].get(a.code) ?? 0 })),
    { label: "費用の合計", values: (i: number) => sumOf(expense, i), strong: true },
    { label: "当期の利益（収益−費用）", values: profit, strong: true },
  ];

  function excel() {
    const rows: XCell[][] = [
      [{ v: "損益計算書", bold: true }, title],
      [],
      [B("科目"), ...months.map((m) => B(mo(m))), B("合計")],
      ...lines.map((l) =>
        l.head
          ? [B(l.label, { left: true, bold: true }), ...months.map(() => B(null)), B(null)]
          : [B(l.label, { left: true, bold: l.strong }), ...months.map((_, i) => B(l.values(i), { num: true, bold: l.strong })), B(total(l.values), { num: true, bold: true })],
      ),
    ];
    downloadXlsx(`損益計算書_${months[0]}.xlsx`, "損益計算書", rows, [24, ...months.map(() => 11), 13]);
  }

  return (
    <section>
      <Heading name="損益計算書" title={title} onExcel={excel} />
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-2 py-2 text-left">科目</th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 text-right whitespace-nowrap">
                  {mo(m)}
                </th>
              ))}
              <th className="px-2 py-2 text-right">合計</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, k) =>
              l.head ? (
                <tr key={k} className="border-t bg-gray-50/50">
                  <td colSpan={months.length + 2} className="px-2 py-1.5 text-xs font-bold text-gray-600">
                    {l.label}
                  </td>
                </tr>
              ) : (
                <tr key={k} className={`border-t ${l.strong ? "bg-gray-50 font-bold" : ""}`}>
                  <td className={`sticky left-0 px-2 py-1.5 whitespace-nowrap ${l.strong ? "bg-gray-50" : "bg-white"}`}>{l.label}</td>
                  {months.map((m, i) => {
                    const v = l.values(i);
                    return (
                      <td key={m} className={`px-2 text-right whitespace-nowrap ${v < 0 ? "text-red-600" : ""}`}>
                        {v ? yen(v) : "－"}
                      </td>
                    );
                  })}
                  <td className={`px-2 text-right font-bold whitespace-nowrap ${total(l.values) < 0 ? "text-red-600" : ""}`}>{yen(total(l.values))}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 貸借対照表：期末の資産・負債・純資産（利益は純資産に入れる） */
function BalanceSheet({ period, title }: { period: Period; title: string }) {
  const of = (k: AccountKind) => period.rows.filter((r) => r.account.kind === k && r.closing !== 0);
  const assets = of("asset");
  const liabilities = of("liability");
  const equity = of("equity");
  const sum = (list: typeof assets) => list.reduce((n, r) => n + r.closing, 0);
  const totalAssets = sum(assets);
  const totalRight = sum(liabilities) + sum(equity) + period.priorProfit + period.profit;
  const left: [string, number, boolean?][] = [...assets.map((r) => [r.account.name, r.closing] as [string, number]), ["資産の合計", totalAssets, true]];
  const right: [string, number, boolean?][] = [
    ...liabilities.map((r) => [r.account.name, r.closing] as [string, number]),
    ["負債の合計", sum(liabilities), true],
    ...equity.map((r) => [r.account.name, r.closing] as [string, number]),
    ["繰越利益（前の期まで）", period.priorProfit],
    ["当期の利益", period.profit],
    ["負債・純資産の合計", totalRight, true],
  ];

  function excel() {
    const n = Math.max(left.length, right.length);
    const rows: XCell[][] = [
      [{ v: "貸借対照表", bold: true }, `${title}　${period.end.slice(0, 4)}年${mo(period.end)}末`],
      [],
      [B("資産の部"), B("金額"), B("負債・純資産の部"), B("金額")],
      ...Array.from({ length: n }, (_, i) => [
        B(left[i]?.[0] ?? null, { left: true, bold: left[i]?.[2] }),
        B(left[i]?.[1] ?? null, { num: true, bold: left[i]?.[2] }),
        B(right[i]?.[0] ?? null, { left: true, bold: right[i]?.[2] }),
        B(right[i]?.[1] ?? null, { num: true, bold: right[i]?.[2] }),
      ]),
    ];
    downloadXlsx(`貸借対照表_${period.end}.xlsx`, "貸借対照表", rows, [24, 14, 24, 14]);
  }

  return (
    <section>
      <Heading name="貸借対照表" title={`${title}　${period.end.slice(0, 4)}年${mo(period.end)}末`} onExcel={excel} />
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <Side head="資産の部" list={left} />
        </div>
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <Side head="負債・純資産の部" list={right} />
        </div>
      </div>
      {totalAssets !== totalRight && <p className="mt-2 text-sm text-red-600">左右の合計が合っていません（{yen(totalAssets - totalRight)}円）。</p>}
      <p className="mt-2 text-xs text-gray-500">はじめて使うときは、仕訳帳で預金・借入金などの残高を「開始残高」を相手に入れると、正しい残高になります。</p>
    </section>
  );
}

function Side({ head, list }: { head: string; list: [string, number, boolean?][] }) {
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="bg-gray-50 text-xs text-gray-600">
        <tr>
          <th className="px-3 py-2 text-left">{head}</th>
          <th className="px-3 py-2 text-right">金額</th>
        </tr>
      </thead>
      <tbody>
        {list.map(([label, v, strong], i) => (
          <tr key={i} className={`border-t ${strong ? "bg-gray-50 font-bold" : ""}`}>
            <td className="px-3 py-1.5">{label}</td>
            <td className={`px-3 text-right ${v < 0 ? "text-red-600" : ""}`}>{yen(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 試算表：科目ごとの 期首残高・借方・貸方・期末残高 */
function TrialBalance({ period, title }: { period: Period; title: string }) {
  const debit = period.rows.reduce((n, r) => n + r.debit, 0);
  const credit = period.rows.reduce((n, r) => n + r.credit, 0);

  function excel() {
    const rows: XCell[][] = [
      [{ v: "合計残高試算表", bold: true }, title],
      [],
      ["コード", "科目", "種類", "期首残高", "借方", "貸方", "期末残高"].map((h) => B(h)),
      ...period.rows.map((r) => [
        B(r.account.code),
        B(r.account.name, { left: true }),
        B(KIND_LABEL[r.account.kind]),
        B(r.opening, { num: true }),
        B(r.debit, { num: true }),
        B(r.credit, { num: true }),
        B(r.closing, { num: true }),
      ]),
      [B(null), B("合計", { bold: true }), B(null), B(null), B(debit, { num: true, bold: true }), B(credit, { num: true, bold: true }), B(null)],
    ];
    downloadXlsx(`試算表_${period.start}.xlsx`, "試算表", rows, [8, 20, 8, 13, 13, 13, 13]);
  }

  return (
    <section>
      <Heading name="試算表" title={title} onExcel={excel} />
      {period.rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">この期の仕訳はありません。</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-[40rem] text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="w-16 px-2 py-2 text-left">コード</th>
                <th className="px-2 py-2 text-left">科目</th>
                <th className="w-14 px-2 py-2 text-left">種類</th>
                <th className="px-2 py-2 text-right">期首残高</th>
                <th className="px-2 py-2 text-right">借方</th>
                <th className="px-2 py-2 text-right">貸方</th>
                <th className="px-2 py-2 text-right">期末残高</th>
              </tr>
            </thead>
            <tbody>
              {period.rows.map((r) => (
                <tr key={r.account.code} className={`border-t ${r.account.code === UNSORTED ? "bg-amber-50" : ""}`}>
                  <td className="px-2 py-1.5">{r.account.code}</td>
                  <td className="px-2">{r.account.name}</td>
                  <td className="px-2 text-xs text-gray-500">{KIND_LABEL[r.account.kind]}</td>
                  <td className="px-2 text-right">{r.opening ? yen(r.opening) : ""}</td>
                  <td className="px-2 text-right">{r.debit ? yen(r.debit) : ""}</td>
                  <td className="px-2 text-right">{r.credit ? yen(r.credit) : ""}</td>
                  <td className={`px-2 text-right font-semibold ${r.closing < 0 ? "text-red-600" : ""}`}>{yen(r.closing)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 bg-gray-50 font-bold">
              <tr>
                <td />
                <td colSpan={3} className="px-2 py-2">
                  合計 {debit === credit ? <span className="ml-2 text-xs font-normal text-emerald-700">借方と貸方が合っています</span> : null}
                </td>
                <td className="px-2 text-right">{yen(debit)}</td>
                <td className="px-2 text-right">{yen(credit)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** 総勘定元帳：1つの科目の出入りと残高 */
function GeneralLedger({ period, accounts, code, setCode, title }: { period: Period; accounts: Account[]; code: string; setCode: (c: string) => void; title: string }) {
  const account = accountOf(accounts, code);
  const opening = period.rows.find((r) => r.account.code === code)?.opening ?? 0;
  const lines = ledgerOf(account, opening, period.during);
  const used = period.rows.map((r) => r.account);
  const options = used.some((a) => a.code === code) ? used : [account, ...used];
  const name = (c: string) => accountOf(accounts, c).name;

  function excel() {
    const rows: XCell[][] = [
      [{ v: `総勘定元帳　${account.code} ${account.name}`, bold: true }, title],
      [],
      ["日付", "相手科目", "摘要", "借方", "貸方", "残高"].map((h) => B(h)),
      [B(null), B(null), B("期首残高", { left: true }), B(null), B(null), B(opening, { num: true })],
      ...lines.map((l) => [B(md(l.date)), B(name(l.other), { left: true }), B(l.memo, { left: true }), B(l.debit || null, { num: true }), B(l.credit || null, { num: true }), B(l.balance, { num: true })]),
    ];
    downloadXlsx(`元帳_${account.name}_${period.start}.xlsx`, account.name.slice(0, 30), rows, [8, 16, 40, 12, 12, 13]);
  }

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">総勘定元帳</h2>
        <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="科目" className="rounded-lg border bg-white px-2 py-1.5">
          {options.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-600">{title}</span>
        <span className="flex-1" />
        <ExcelButton onClick={excel} />
      </div>
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[44rem] text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="w-16 px-2 py-2 text-left">日付</th>
              <th className="w-32 px-2 py-2 text-left">相手科目</th>
              <th className="px-2 py-2 text-left">摘要</th>
              <th className="w-28 px-2 py-2 text-right">借方</th>
              <th className="w-28 px-2 py-2 text-right">貸方</th>
              <th className="w-28 px-2 py-2 text-right">残高</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t bg-amber-50/60">
              <td />
              <td />
              <td className="px-2 py-1.5 font-semibold">期首残高</td>
              <td />
              <td />
              <td className="px-2 text-right font-semibold">{yen(opening)}</td>
            </tr>
            {lines.map((l, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1.5">{md(l.date)}</td>
                <td className="px-2">{name(l.other)}</td>
                <td className="px-2">
                  {l.memo}
                  {l.source === "cash" && <span className="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-500">出納帳</span>}
                </td>
                <td className="px-2 text-right">{l.debit ? yen(l.debit) : ""}</td>
                <td className="px-2 text-right">{l.credit ? yen(l.credit) : ""}</td>
                <td className={`px-2 text-right ${l.balance < 0 ? "text-red-600" : ""}`}>{yen(l.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length === 0 && <p className="p-3 text-sm text-gray-500">この期の出入りはありません。</p>}
      </div>
    </section>
  );
}
