"use client";

// 帳簿：決算書・元帳。期（会計年度）ごとに、損益計算書（月別）・貸借対照表・試算表・総勘定元帳を出す
import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import {
  accountOf,
  buildPeriod,
  CASH,
  fiscalLabel,
  fiscalMonths,
  fiscalStartOf,
  fullName,
  KIND_LABEL,
  ledgerOf,
  monthlyAmounts,
  monthsWithData,
  lineValue,
  statementLines,
  postingsInRange,
  debitSide,
  UNSORTED,
  useBooks,
  useLedgerConfig,
  type Account,
  type AccountKind,
  type Books,
  type LedgerConfig,
  type StatementLine,
} from "@/lib/books";
import { downloadXlsx, type XCell } from "@/lib/xlsxWrite";
import { canUseLedger, LedgerHeader, yen } from "../parts";

type Tab = "pl" | "mfg" | "bs" | "tb" | "gl";
const TABS: { key: Tab; label: string }[] = [
  { key: "pl", label: "損益計算書" },
  { key: "mfg", label: "製造原価報告書" },
  { key: "bs", label: "貸借対照表" },
  { key: "tb", label: "試算表" },
  { key: "gl", label: "総勘定元帳" },
];
const SOURCE_LABEL = { cash: "出納帳", auto: "自動", bank: "通帳", imported: "試算表", manual: "" };
const mo = (ym: string) => `${Number(ym.slice(5))}月`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const B = (v: string | number | null, o: { num?: boolean; bold?: boolean; left?: boolean } = {}): XCell => ({ v, border: true, ...o });

export default function ReportsPage() {
  const { role } = useAuth();
  const { value: books, error: e1 } = useBooks();
  const { value: config, error: e3 } = useLedgerConfig();
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e3;
  return (
    <div className="pb-24">
      <LedgerHeader title="決算書・元帳" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !books || !config ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Reports books={books} config={config} />
      )}
    </div>
  );
}

function Reports({ books: raw, config }: { books: Books; config: LedgerConfig }) {
  // 税抜きで見る：アプリでつけた月（試算表を取り込んでいない月）は、税率で税抜きにし、消費税を仮払・仮受消費税に分ける
  const [taxEx, setTaxEx] = useState(true);
  const books: Books = { ...raw, taxEx };
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

  const period = buildPeriod(books, config, fixedStart, end);
  const unsorted = period.during.filter((p) => p.debit === UNSORTED || p.credit === UNSORTED).length;
  // 選べる期：データのある期と、いまの期
  const starts = [...new Set([...monthsWithData(books), thisMonth].map((m) => fiscalStartOf(m, config.fiscalStart)))].sort().reverse();
  const title = `${fiscalLabel(fixedStart)}${end !== months[11] ? `（${mo(end)}まで）` : ""}${taxEx ? "（税抜き）" : "（税込み）"}`;

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
        <label className="flex items-center gap-1 text-sm" title="試算表を取り込んだ月は、会計ソフトの数字（税込）のままです">
          <input type="checkbox" checked={taxEx} onChange={(e) => setTaxEx(e.target.checked)} />
          税抜きで見る
        </label>
        <Regenerate months={months.filter((m) => m <= end && m <= thisMonth)} />
        <button onClick={() => window.print()} className="rounded-lg border bg-white px-3 py-2 text-sm">
          🖨 印刷
        </button>
      </div>
      {unsorted > 0 && (
        <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 print:hidden">
          この期に、科目が決まっていない出納帳・通帳の行が {unsorted} 行あります（「未分類」の費用として数えています）。
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
        {(tab === "pl" || tab === "mfg") && <Statement key={tab} which={tab} books={books} config={config} months={months.filter((m) => m <= end)} title={title} />}
        {tab === "bs" && <BalanceSheet period={period} accounts={config.accounts} title={title} />}
        {tab === "tb" && <TrialBalance period={period} accounts={config.accounts} title={title} books={books} config={config} />}
        {tab === "gl" && <GeneralLedger period={period} accounts={config.accounts} code={glCode} setCode={setGlCode} title={title} />}
      </div>
    </>
  );
}

type Period = ReturnType<typeof buildPeriod>;

/** この期のレジ・売掛・給与の自動仕訳を、月ごとに作り直す */
function Regenerate({ months }: { months: string[] }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  async function run() {
    setMsg("");
    try {
      for (const m of months) {
        setBusy(mo(m));
        await callFunction("buildAutoJournal", { month: m });
      }
      setMsg("作り直しました");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <span className="flex items-center gap-2 text-sm">
      {msg && <span className="text-gray-600">{msg}</span>}
      <button onClick={run} disabled={!!busy || months.length === 0} className="rounded-lg border border-berry bg-white px-3 py-2 text-berry disabled:opacity-50">
        {busy ? `${busy}を作っています…` : "🔄 レジ・給与の仕訳を作り直す"}
      </button>
    </span>
  );
}

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

/**
 * 損益計算書・製造原価報告書：試算表（丸北農場の合計残高試算表）と同じ並びで、月別と期の合計。
 * 構成比は、損益計算書は売上高計、製造原価報告書は当期総製造費用を100とした割合
 */
function Statement({ which, books, config, months, title }: { which: "pl" | "mfg"; books: Books; config: LedgerConfig; months: string[]; title: string }) {
  const name = which === "pl" ? "損益計算書" : "製造原価報告書";
  const byMonth = monthlyAmounts(books, config, months);
  const used = new Set(byMonth.flatMap((m) => [...m.entries()].filter(([, v]) => v).map(([c]) => c)));
  const lines = statementLines(config.accounts, used, which);
  const sumAll = new Map<string, number>();
  for (const m of byMonth) for (const [c, v] of m) sumAll.set(c, (sumAll.get(c) ?? 0) + v);
  const base = lineValue(lines.find((l) => l.label === (which === "pl" ? "売上高計" : "当期総製造費用"))!, sumAll);
  const ratio = (v: number) => (base ? ((v / base) * 100).toFixed(2) : "");
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  // 「内訳もいっしょに印刷」：表のあとに、金額のある科目ごとの内訳（仕訳）を印刷に出す
  const [withDetails, setWithDetails] = useState(false);
  // 補助科目のある科目は、補助科目に出る分を除いた、その科目だけの分（同じ仕訳を2回出さない）
  const items = lines.flatMap((l, k) => {
    if (l.type !== "item") return [];
    const subs: string[] = [];
    for (const c of lines.slice(k + 1)) {
      if (c.type !== "item" || c.indent <= l.indent) break;
      subs.push(...c.terms.map((t) => t.code));
    }
    const own = { ...l, terms: l.terms.filter((t) => !subs.includes(t.code)) };
    return own.terms.length && lineValue(own, sumAll) ? [own] : [];
  });

  function excel() {
    const rows: XCell[][] = [
      [{ v: name, bold: true }, title],
      [],
      [B("勘定科目"), ...months.map((m) => B(mo(m))), B("合計"), B("構成比")],
      ...lines.map((l) => {
        const label = "　".repeat(l.indent) + l.label;
        if (l.type === "head" || l.type === "sub") return [B(label, { left: true, bold: true }), ...months.map(() => B(null)), B(null), B(null)];
        const bold = l.type !== "item";
        const t = lineValue(l, sumAll);
        return [B(label, { left: true, bold }), ...byMonth.map((m) => B(lineValue(l, m), { num: true, bold })), B(t, { num: true, bold: true }), B(ratio(t))];
      }),
    ];
    downloadXlsx(`${name}_${months[0]}.xlsx`, name, rows, [26, ...months.map(() => 11), 13, 8]);
  }

  return (
    <section>
      {drill && <Drill books={books} config={config} {...drill} onClose={() => setDrill(null)} />}
      <Heading name={name} title={title} onExcel={excel} />
      <div className="mt-1 flex flex-wrap items-center gap-3 print:hidden">
        <p className="text-xs text-gray-500">金額を押すと、その内訳（仕訳）が出ます。</p>
        <button
          onClick={() => {
            setWithDetails(true);
            printThen(() => setWithDetails(false));
          }}
          className="rounded-lg border bg-white px-3 py-1 text-sm"
        >
          🖨 内訳もいっしょに印刷（{items.length}科目）
        </button>
      </div>
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-sky-50 text-xs text-gray-600">
            <tr>
              <th className="sticky left-0 bg-sky-50 px-2 py-2 text-left">勘定科目</th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 text-right whitespace-nowrap">
                  {mo(m)}
                </th>
              ))}
              <th className="px-2 py-2 text-right">合計</th>
              <th className="px-2 py-2 text-right">構成比</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, k) => {
              if (l.type === "head" || l.type === "sub")
                return (
                  <tr key={k} className="border-t">
                    <td colSpan={months.length + 3} className={`px-2 py-1.5 ${l.type === "head" ? "font-bold" : "text-xs text-gray-600"}`}>
                      {l.label}
                    </td>
                  </tr>
                );
              const strong = l.type !== "item";
              const bg = l.type === "result" ? "bg-sky-100" : l.type === "total" ? "bg-sky-50" : "bg-white";
              const t = lineValue(l, sumAll);
              return (
                <tr key={k} className={`border-t ${bg} ${strong ? "font-bold" : ""}`}>
                  <td className={`sticky left-0 py-1.5 pr-2 whitespace-nowrap ${bg} ${l.indent === 2 ? "pl-8" : l.indent === 1 ? "pl-4" : "pl-2"}`}>{l.label}</td>
                  {byMonth.map((m, i) => {
                    const v = lineValue(l, m);
                    return (
                      <td key={months[i]} className={`px-2 text-right whitespace-nowrap ${v < 0 ? "text-red-600" : ""}`}>
                        {v ? (
                          <button onClick={() => setDrill({ title: `${l.label}　${mo(months[i])}`, terms: l.terms, from: months[i], to: months[i] })} className="underline decoration-dotted underline-offset-2 hover:text-berry">
                            {yen(v)}
                          </button>
                        ) : (
                          "－"
                        )}
                      </td>
                    );
                  })}
                  <td className={`px-2 text-right font-bold whitespace-nowrap ${t < 0 ? "text-red-600" : ""}`}>
                    {t ? (
                      <button
                        onClick={() => setDrill({ title: `${l.label}　${mo(months[0])}〜${mo(months[months.length - 1])}`, terms: l.terms, from: months[0], to: months[months.length - 1] })}
                        className="underline decoration-dotted underline-offset-2 hover:text-berry"
                      >
                        {yen(t)}
                      </button>
                    ) : (
                      yen(t)
                    )}
                  </td>
                  <td className="px-2 text-right text-xs whitespace-nowrap text-gray-600">{ratio(t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {withDetails && (
        <div className="hidden print:block">
          {items.map((l, k) => (
            <section key={k} className={k === 0 ? "break-before-page" : "mt-6"}>
              <h3 className="font-bold break-after-avoid">
                {name}の内訳：{l.label}　{mo(months[0])}〜{mo(months[months.length - 1])}　{yen(lineValue(l, sumAll))}円
              </h3>
              <DrillTable rows={drillRows(books, config, l.terms, months[0], months[months.length - 1])} accounts={config.accounts} />
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/** 貸借対照表：期末の資産・負債・純資産（利益は純資産に入れる） */
function BalanceSheet({ period, accounts, title }: { period: Period; accounts: Account[]; title: string }) {
  const of = (k: AccountKind) => period.rows.filter((r) => r.account.kind === k && r.closing !== 0);
  const assets = of("asset");
  const liabilities = of("liability");
  const equity = of("equity");
  const sum = (list: typeof assets) => list.reduce((n, r) => n + r.closing, 0);
  const totalAssets = sum(assets);
  const totalRight = sum(liabilities) + sum(equity) + period.priorProfit + period.profit;
  const left: [string, number, boolean?][] = [...assets.map((r) => [fullName(accounts, r.account), r.closing] as [string, number]), ["資産の合計", totalAssets, true]];
  const right: [string, number, boolean?][] = [
    ...liabilities.map((r) => [fullName(accounts, r.account), r.closing] as [string, number]),
    ["負債の合計", sum(liabilities), true],
    ...equity.map((r) => [fullName(accounts, r.account), r.closing] as [string, number]),
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
      <p className="mt-2 text-xs text-gray-500">はじめて使うときは、会計ソフトの試算表を取り込むか、仕訳帳で預金・借入金などの残高を「開始残高」を相手に入れると、正しい残高になります。</p>
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
function TrialBalance({ period, accounts, title, books, config }: { period: Period; accounts: Account[]; title: string; books: Books; config: LedgerConfig }) {
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const debit = period.rows.reduce((n, r) => n + r.debit, 0);
  const credit = period.rows.reduce((n, r) => n + r.credit, 0);

  function excel() {
    const rows: XCell[][] = [
      [{ v: "合計残高試算表", bold: true }, title],
      [],
      ["コード", "科目", "種類", "期首残高", "借方", "貸方", "期末残高"].map((h) => B(h)),
      ...period.rows.map((r) => [
        B(r.account.code),
        B(fullName(accounts, r.account), { left: true }),
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
      {drill && <Drill books={books} config={config} {...drill} onClose={() => setDrill(null)} />}
      <Heading name="試算表" title={title} onExcel={excel} />
      <p className="mt-1 text-xs text-gray-500 print:hidden">科目を押すと、その期の仕訳が出ます。</p>
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
                  <td className="px-2">
                    <button
                      onClick={() => setDrill({ title: `${fullName(accounts, r.account)}　${mo(period.start)}〜${mo(period.end)}`, terms: [{ code: r.account.code, sign: 1 }], from: period.start, to: period.end })}
                      className="text-left underline decoration-dotted underline-offset-2 hover:text-berry"
                    >
                      {fullName(accounts, r.account)}
                    </button>
                  </td>
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
  const name = (c: string) => fullName(accounts, accountOf(accounts, c));

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
              {a.code} {fullName(accounts, a)}
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
                  {l.memo2 && <span className="ml-1 text-xs text-gray-500">{l.memo2}</span>}
                  {l.source !== "manual" && <span className="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-500">{SOURCE_LABEL[l.source]}</span>}
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

type DrillTarget = { title: string; terms: StatementLine["terms"]; from: string; to: string };

/**
 * 内訳：その金額のもとになった仕訳の一覧。行の金額は、表の金額と同じ向き（収益は貸方、費用は借方をプラス）。
 * 試算表を取り込んだ月は、会計ソフトの月の合計（借方・貸方）が1行ずつ出る
 */
function drillRows(books: Books, config: LedgerConfig, terms: StatementLine["terms"], from: string, to: string) {
  const accounts = config.accounts;
  return postingsInRange(books, config, from, to).flatMap((p) =>
    terms
      .filter((t) => p.debit === t.code || p.credit === t.code)
      .map((t) => {
        const isDebit = p.debit === t.code;
        const v = debitSide(accountOf(accounts, t.code).kind) === isDebit ? p.amount : -p.amount;
        return { p, code: t.code, other: isDebit ? p.credit : p.debit, value: t.sign * v };
      }),
  );
}

/** 内訳の表（画面の内訳と、印刷の内訳で同じもの） */
function DrillTable({ rows, accounts }: { rows: ReturnType<typeof drillRows>; accounts: Account[] }) {
  const name = (c: string) => fullName(accounts, accountOf(accounts, c));
  const total = rows.reduce((n, r) => n + r.value, 0);
  const many = new Set(rows.map((r) => r.code)).size > 1;
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="sticky top-0 bg-gray-50 text-xs text-gray-600 print:static">
        <tr>
          <th className="w-16 px-2 py-2 text-left">日付</th>
          {many && <th className="px-2 py-2 text-left">科目</th>}
          <th className="px-2 py-2 text-left">相手科目</th>
          <th className="px-2 py-2 text-left">摘要</th>
          <th className="w-28 px-2 py-2 text-right">金額</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t break-inside-avoid">
            <td className="px-2 py-1.5">{md(r.p.date)}</td>
            {many && <td className="px-2 text-xs">{name(r.code)}</td>}
            <td className="px-2 text-xs">{name(r.other)}</td>
            <td className="px-2">
              {r.p.memo}
              {r.p.memo2 && <span className="ml-1 text-xs text-gray-500">{r.p.memo2}</span>}
              {r.p.source !== "manual" && <span className="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-500">{SOURCE_LABEL[r.p.source]}</span>}
            </td>
            <td className={`px-2 text-right ${r.value < 0 ? "text-red-600" : ""}`}>{yen(r.value)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t-2 bg-gray-50 font-bold">
        <tr>
          <td colSpan={many ? 4 : 3} className="px-2 py-2">
            合計
          </td>
          <td className="px-2 text-right">{yen(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** 印刷する：印刷が終わったら、印刷用に出したものを片付ける */
function printThen(done: () => void) {
  const after = () => {
    window.removeEventListener("afterprint", after);
    done();
  };
  window.addEventListener("afterprint", after);
  // 印刷用のものが画面に出てから
  setTimeout(() => window.print(), 50);
}

function Drill({ books, config, title, terms, from, to, onClose }: DrillTarget & { books: Books; config: LedgerConfig; onClose: () => void }) {
  const rows = drillRows(books, config, terms, from, to);
  const total = rows.reduce((n, r) => n + r.value, 0);
  // この内訳だけを印刷するときは、ページのほかのところを印刷に出さない
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("print-drill", printing);
    return () => document.body.classList.remove("print-drill");
  }, [printing]);
  // body の直下に出す（この内訳だけを印刷するとき、ほかを印刷から外せるように）
  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 ${printing ? "drill-print" : "print:hidden"}`} onClick={onClose}>
      <div className="mt-8 w-full max-w-4xl rounded-2xl bg-white p-4 shadow-xl print:mt-0 print:max-w-none print:rounded-none print:p-0 print:shadow-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold">内訳：{title}</h3>
          <span className="flex-1" />
          <button
            onClick={() => {
              setPrinting(true);
              printThen(() => setPrinting(false));
            }}
            className="rounded-lg border px-3 py-1 text-sm print:hidden"
          >
            🖨 この内訳を印刷
          </button>
          <button onClick={onClose} className="rounded-lg border px-3 py-1 text-sm print:hidden">
            閉じる
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {rows.length}行　合計 {yen(total)}円
        </p>
        <div className="mt-2 max-h-[70vh] overflow-auto print:max-h-none print:overflow-visible">
          <DrillTable rows={rows} accounts={config.accounts} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
