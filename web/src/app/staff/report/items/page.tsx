"use client";

// 商品別の実績：日・週・月・年間で、商品ごとの販売数と売上を出す（アプリの会計から）。
// 週・月・年間は、去年の同じ時期と比べられる。去年の数字は、アプリの会計と、Airレジの「商品別」CSV（取り込み済みで、その期間の中に収まるもの）を足して出す。
import Link from "next/link";
import { useState } from "react";
import { addDays, formatJa, shiftMonth, todayJST, weeksOf } from "@/lib/date";
import { useItemRefs, type ItemRefDoc } from "@/lib/itemRefs";
import { yen } from "@/lib/reservations";
import { downloadCsv } from "@/lib/report";
import { useSales, type Sale } from "@/lib/sales";

type Unit = "day" | "week" | "month" | "year";
const UNITS: { key: Unit; label: string }[] = [
  { key: "day", label: "日" },
  { key: "week", label: "週" },
  { key: "month", label: "月" },
  { key: "year", label: "年間" },
];
type Period = { from: string; to: string; label: string };
type Totals = Map<string, { category: string; qty: number; amount: number }>;

const lastDay = (ym: string) => addDays(`${shiftMonth(ym, 1)}-01`, -1);
/** 日付の年だけを変える（2/29は2/28にする） */
const withYear = (ymd: string, year: number) => `${year}-${ymd.slice(5) === "02-29" ? "02-28" : ymd.slice(5)}`;

/** 選んだ日を含む期間（週は日曜はじまり。年の第何週かで去年と合わせる） */
function periodOf(unit: Unit, date: string): Period & { weekNo?: number } {
  const y = Number(date.slice(0, 4));
  if (unit === "day") return { from: date, to: date, label: formatJa(date, true) };
  if (unit === "month") {
    const ym = date.slice(0, 7);
    return { from: `${ym}-01`, to: lastDay(ym), label: `${y}年${Number(ym.slice(5))}月` };
  }
  if (unit === "year") return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}年` };
  const w = weeksOf(y).find((x) => x.from <= date && date <= x.to) ?? weeksOf(y + 1)[0];
  return { from: w.from, to: w.to, label: `${y}年 第${w.no}週（${formatJa(w.from)}〜${formatJa(w.to)}）`, weekNo: w.no };
}
/** 去年の同じ時期 */
function lastYearOf(unit: Unit, p: Period & { weekNo?: number }): Period {
  const y = Number(p.from.slice(0, 4)) - 1;
  if (unit === "week" && p.weekNo) {
    const w = weeksOf(y).find((x) => x.no === p.weekNo) ?? weeksOf(y).at(-1)!;
    return { from: w.from, to: w.to, label: `${y}年 第${w.no}週（${formatJa(w.from)}〜${formatJa(w.to)}）` };
  }
  if (unit === "month") return { from: withYear(p.from, y), to: lastDay(`${y}-${p.from.slice(5, 7)}`), label: `${y}年${Number(p.from.slice(5, 7))}月` };
  if (unit === "year") return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}年` };
  return { from: withYear(p.from, y), to: withYear(p.to, y), label: formatJa(withYear(p.from, y), true) };
}
/** 選んだ日を、期間の単位で前後に動かす */
function move(unit: Unit, date: string, n: number): string {
  if (unit === "day") return addDays(date, n);
  if (unit === "week") return addDays(date, 7 * n);
  if (unit === "month") return `${shiftMonth(date.slice(0, 7), n)}-01`;
  return `${Number(date.slice(0, 4)) + n}-01-01`;
}

const daysOf = (r: ItemRefDoc) => (Date.parse(r.to) - Date.parse(r.from)) / 86400_000;

/** アプリの会計を、商品ごとに足す */
function addSales(t: Totals, sales: Sale[] | null) {
  for (const s of sales ?? []) {
    if (s.status !== "completed") continue;
    for (const l of s.lines) {
      const c = t.get(l.name) ?? { category: l.category || "", qty: 0, amount: 0 };
      t.set(l.name, { category: c.category || l.category || "", qty: c.qty + l.qty, amount: c.amount + l.amount });
    }
  }
}

export default function ItemReportPage() {
  const [unit, setUnit] = useState<Unit>("month");
  const [date, setDate] = useState(todayJST());
  const [compare, setCompare] = useState(true);
  const p = periodOf(unit, date);
  const ly = lastYearOf(unit, p);
  const canCompare = unit !== "day";
  const showLy = canCompare && compare;
  const { value: sales } = useSales(p.from, p.to);
  const { value: lySales } = useSales(showLy ? ly.from : "9999-01-01", showLy ? ly.to : "9999-01-01");
  const { value: refs } = useItemRefs();

  const now: Totals = new Map();
  addSales(now, sales);
  // 去年：アプリの会計 ＋ Airレジの商品別（期間の中に収まる取り込み分）
  const last: Totals = new Map();
  const usedRefs: ItemRefDoc[] = [];
  if (showLy) {
    addSales(last, lySales);
    // 期間の中に収まる取り込み分を、長い期間のものから使う（重なる分は二重に数えない）
    for (const r of (refs ?? []).filter((x) => x.from >= ly.from && x.to <= ly.to).sort((x, y) => daysOf(y) - daysOf(x)))
      if (!usedRefs.some((u) => u.from <= r.to && r.from <= u.to)) usedRefs.push(r);
    for (const r of usedRefs)
      for (const i of r.items) {
        const c = last.get(i.name) ?? { category: i.category, qty: 0, amount: 0 };
        last.set(i.name, { category: c.category || i.category, qty: c.qty + i.qty, amount: c.amount + i.amount });
      }
  }
  const names = [...new Set([...now.keys(), ...last.keys()])];
  const rows = names
    .map((name) => ({ name, category: now.get(name)?.category || last.get(name)?.category || "その他", now: now.get(name), last: last.get(name) }))
    .sort((a, b) => (b.now?.amount ?? 0) - (a.now?.amount ?? 0) || (b.last?.amount ?? 0) - (a.last?.amount ?? 0));
  // カテゴリーごとにまとめる（売上の多いカテゴリーから）
  const cats = [...new Set(rows.map((r) => r.category))]
    .map((c) => {
      const rs = rows.filter((r) => r.category === c);
      const sum = (f: (r: (typeof rows)[number]) => number) => rs.reduce((n, r) => n + f(r), 0);
      return { name: c, rows: rs, nowQty: sum((r) => r.now?.qty ?? 0), nowAmt: sum((r) => r.now?.amount ?? 0), lastQty: sum((r) => r.last?.qty ?? 0), lastAmt: sum((r) => r.last?.amount ?? 0) };
    })
    .sort((a, b) => b.nowAmt - a.nowAmt || b.lastAmt - a.lastAmt);
  const nowTotal = cats.reduce((n, c) => n + c.nowAmt, 0);
  const lastTotal = cats.reduce((n, c) => n + c.lastAmt, 0);
  const ratio = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const n = (v: number | undefined) => (v ? v.toLocaleString("ja-JP") : "—");

  function exportCsv() {
    const head = ["カテゴリー", "商品名", "販売数", "売上", ...(showLy ? ["去年 販売数", "去年 売上", "前年比"] : [])];
    downloadCsv(`items_${p.from}_${p.to}.csv`, [
      head,
      ...rows.map((r) => [r.category, r.name, r.now?.qty ?? 0, r.now?.amount ?? 0, ...(showLy ? [r.last?.qty ?? 0, r.last?.amount ?? 0, ratio(r.now?.amount ?? 0, r.last?.amount ?? 0)] : [])]),
    ]);
  }

  const seg = (on: boolean) => `px-4 py-2 ${on ? "bg-berry font-bold text-white" : ""}`;
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/store/" className="text-gray-500 underline">
          ← 店舗実績
        </Link>
        <Link href="/staff/report/" className="ml-4 text-gray-500 underline">
          集計（期間指定）
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">商品別の実績</h1>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border bg-white">
          {UNITS.map((u) => (
            <button key={u.key} onClick={() => setUnit(u.key)} className={seg(unit === u.key)}>
              {u.label}
            </button>
          ))}
        </div>
        <button onClick={() => setDate(move(unit, date, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前
        </button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="rounded-lg border px-2 py-2 text-base" />
        <button onClick={() => setDate(move(unit, date, 1))} className="rounded-lg border bg-white px-3 py-2">
          次 ›
        </button>
        <button onClick={() => setDate(todayJST())} className="rounded-lg border bg-white px-3 py-2">
          今日
        </button>
        {canCompare && (
          <label className="ml-2 flex items-center gap-1.5 text-sm font-bold">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="h-5 w-5" />
            去年と比較
          </label>
        )}
      </div>
      <p className="mt-2 font-bold">{p.label}</p>
      {showLy && (
        <p className="text-sm text-gray-600">
          比べる去年：{ly.label}
          {usedRefs.length > 0 && `（Airレジの商品別 ${usedRefs.map((r) => `${formatJa(r.from)}〜${formatJa(r.to)}`).join("・")} を含む）`}
        </p>
      )}

      <div className={`mt-3 grid gap-3 ${showLy ? "grid-cols-3" : "grid-cols-1 sm:grid-cols-3"}`}>
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="text-xs text-gray-500">売上</div>
          <div className="text-xl font-bold tabular-nums">{sales ? yen(nowTotal) : "…"}</div>
        </div>
        {showLy && (
          <>
            <div className="rounded-2xl bg-white p-3 shadow-sm">
              <div className="text-xs text-gray-500">去年の売上</div>
              <div className="text-xl font-bold tabular-nums">{lySales ? yen(lastTotal) : "…"}</div>
            </div>
            <div className="rounded-2xl bg-white p-3 shadow-sm">
              <div className="text-xs text-gray-500">前年比</div>
              <div className="text-xl font-bold tabular-nums">{ratio(nowTotal, lastTotal)}</div>
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-lg bg-white p-4 text-sm text-gray-500">この期間の売上はありません。</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-max text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">商品名</th>
                <th className="px-3 py-2 text-right">販売数</th>
                <th className="px-3 py-2 text-right">売上</th>
                {showLy && (
                  <>
                    <th className="px-3 py-2 text-right">去年 販売数</th>
                    <th className="px-3 py-2 text-right">去年 売上</th>
                    <th className="px-3 py-2 text-right">前年比</th>
                  </>
                )}
              </tr>
            </thead>
            {cats.map((c) => (
              <tbody key={c.name}>
                <tr className="border-t-2 border-gray-300 bg-berry/5 font-bold">
                  <td className="px-3 py-1.5">{c.name}</td>
                  <td className="px-3 py-1.5 text-right">{n(c.nowQty)}</td>
                  <td className="px-3 py-1.5 text-right">{yen(c.nowAmt)}</td>
                  {showLy && (
                    <>
                      <td className="px-3 py-1.5 text-right">{n(c.lastQty)}</td>
                      <td className="px-3 py-1.5 text-right">{yen(c.lastAmt)}</td>
                      <td className="px-3 py-1.5 text-right">{ratio(c.nowAmt, c.lastAmt)}</td>
                    </>
                  )}
                </tr>
                {c.rows.map((r) => (
                  <tr key={r.name} className="border-t">
                    <td className="py-1.5 pl-6 pr-3">{r.name}</td>
                    <td className="px-3 py-1.5 text-right">{n(r.now?.qty)}</td>
                    <td className="px-3 py-1.5 text-right">{r.now ? yen(r.now.amount) : "—"}</td>
                    {showLy && (
                      <>
                        <td className="px-3 py-1.5 text-right">{n(r.last?.qty)}</td>
                        <td className="px-3 py-1.5 text-right">{r.last ? yen(r.last.amount) : "—"}</td>
                        <td className="px-3 py-1.5 text-right">{ratio(r.now?.amount ?? 0, r.last?.amount ?? 0)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">
        数字はアプリの会計で売った分です。去年（アプリを使う前）の数字は、取り込んだAirレジの「商品別」CSVのうち、比べる期間の中に収まるものだけを足しています。週や月で去年と比べたいときは、Airレジからその週・月の「商品別」CSVを書き出して
        <Link href="/staff/import/" className="underline">
          取り込み
        </Link>
        の画面（管理者）で取り込んでください。
      </p>
    </>
  );
}
