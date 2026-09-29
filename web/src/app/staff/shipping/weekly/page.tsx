"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Legend, SERIES_COLORS, StackedColumns, type Series } from "@/components/charts";
import { addDays, todayJST } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { unitWeight, useShipments, useShippingConfig, type DayItems, type Grade } from "@/lib/shipping";

/**
 * 1年を52週（日曜はじまり〜土曜）に分ける。
 * 第1週は、1月1日を含む週（その前の日曜から）。年末の週が翌年にまたがるときは、その週までを数える（53週になる年もある）。
 */
function weeksOf(year: number): { no: number; from: string; to: string }[] {
  const jan1 = `${year}-01-01`;
  const dow = new Date(`${jan1}T00:00:00Z`).getUTCDay();
  let start = addDays(jan1, -dow);
  const out: { no: number; from: string; to: string }[] = [];
  for (let no = 1; start <= `${year}-12-31`; no++) {
    out.push({ no, from: start, to: addDays(start, 6) });
    start = addDays(start, 7);
  }
  return out;
}
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const num = (n: number) => n.toLocaleString("ja-JP");

type WeekRow = {
  no: number;
  from: string;
  to: string;
  packs: number;
  berries: number;
  kg: number;
  amount: number;
  byGrade: Record<string, number>;
  byGroup: Record<string, number>;
  days: number;
};

export default function WeeklyPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <WeeklyView />
    </Suspense>
  );
}

function WeeklyView() {
  const params = useSearchParams();
  const router = useRouter();
  const thisYear = Number(todayJST().slice(0, 4));
  const y = Number(params.get("year"));
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : thisYear;
  const weeks = useMemo(() => weeksOf(year), [year]);
  // 第1週は前の年の12月から、最後の週は次の年の1月まで入ることがあるので、その分も読む
  const days = useShipments(weeks[0].from, weeks[weeks.length - 1].to);
  const { value: config } = useShippingConfig();
  const [showEmpty, setShowEmpty] = useState(false);
  const years = Array.from({ length: thisYear - 2023 + 2 }, (_, i) => thisYear + 1 - i);

  const data = useMemo(() => {
    if (!days || !config) return null;
    const grades = config.grades;
    const groups = [...new Set(grades.map((g) => g.group))];
    const rows: WeekRow[] = weeks.map((w) => {
      const r: WeekRow = { ...w, packs: 0, berries: 0, kg: 0, amount: 0, byGrade: {}, byGroup: {}, days: 0 };
      for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
        const items: DayItems = days[d] ?? {};
        let any = false;
        for (const g of grades) {
          const it = items[g.id];
          if (!it?.qty) continue;
          any = true;
          const count = g.count || 1;
          if (count > 1) r.packs += it.qty;
          r.berries += it.qty * count;
          r.kg += (it.qty * unitWeight(g)) / 1000;
          const amt = it.qty * (it.price ?? 0);
          r.amount += amt;
          r.byGrade[g.id] = (r.byGrade[g.id] ?? 0) + it.qty;
          r.byGroup[g.group] = (r.byGroup[g.group] ?? 0) + amt;
        }
        if (any) r.days++;
      }
      r.kg = Math.round(r.kg * 10) / 10;
      return r;
    });
    return { rows, grades, groups };
  }, [days, config, weeks]);

  return (
    <>
      <p className="text-sm">
        <Link href={`/staff/shipping/?month=${year === thisYear ? todayJST().slice(0, 7) : `${year}-06`}`} className="text-gray-500 underline">
          ← 出荷実績
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">出荷の実績集計（週ごと）</h1>
      <div className="mt-3 flex flex-wrap gap-2">
        {years.map((yy) => (
          <button
            key={yy}
            onClick={() => router.replace(`/staff/shipping/weekly/?year=${yy}`)}
            className={`rounded-full border px-4 py-2 text-sm ${yy === year ? "border-berry bg-berry font-bold text-white" : "bg-white"}`}
          >
            {yy}年（令和{yy - 2018}年）
          </button>
        ))}
      </div>
      {!data ? <p className="mt-4 text-gray-500">読み込み中…</p> : <Report year={year} {...data} showEmpty={showEmpty} setShowEmpty={setShowEmpty} />}
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

function Report({
  year,
  rows,
  grades,
  groups,
  showEmpty,
  setShowEmpty,
}: {
  year: number;
  rows: WeekRow[];
  grades: Grade[];
  groups: string[];
  showEmpty: boolean;
  setShowEmpty: (v: boolean) => void;
}) {
  const withData = rows.filter((r) => r.packs + r.berries > 0);
  if (withData.length === 0) return <p className="mt-4 text-gray-500">{year}年の出荷の記録はまだありません。</p>;
  const tot = (f: (r: WeekRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const total = { packs: tot((r) => r.packs), berries: tot((r) => r.berries), kg: Math.round(tot((r) => r.kg) * 10) / 10, amount: tot((r) => r.amount), days: tot((r) => r.days) };
  // グラフは、出荷があった最初の週から最後の週まで
  const first = rows.indexOf(withData[0]);
  const last = rows.indexOf(withData[withData.length - 1]);
  const chartRows = rows.slice(first, last + 1).map((r) => ({ key: String(r.no), label: `${r.no}`, sub: `第${r.no}週（${md(r.from)}〜${md(r.to)}）`, values: r.byGroup }));
  const series: Series[] = groups.map((g, i) => ({ key: g, label: g, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  const shown = showEmpty ? rows : rows.slice(first, last + 1);
  const best = withData.reduce((a, b) => (b.amount > a.amount ? b : a));

  function exportCsv() {
    downloadCsv(`shipping_weekly_${year}.csv`, [
      ["週", "期間", "出荷日数", "パック数量", "粒数", "重量kg", "金額", ...grades.map((g) => `${g.group} ${g.name}`)],
      ...shown.map((r) => [r.no, `${r.from}〜${r.to}`, r.days, r.packs, r.berries, r.kg, r.amount, ...grades.map((g) => r.byGrade[g.id] ?? "")]),
      ["合計", "", total.days, total.packs, total.berries, total.kg, total.amount, ...grades.map((g) => tot((r) => r.byGrade[g.id] ?? 0))],
    ]);
  }

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label={`${year}年の出荷金額`} value={yen(total.amount)} strong />
        <Tile label="パック数量" value={num(total.packs)} />
        <Tile label="粒数" value={`${num(total.berries)}粒`} />
        <Tile label="出荷重量" value={`${num(total.kg)}kg`} />
        <Tile label="いちばん多かった週" value={`第${best.no}週`} sub={`${md(best.from)}〜${md(best.to)}・${yen(best.amount)}`} />
      </div>

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">週ごとの出荷金額</h2>
          <Legend series={series} />
        </div>
        <p className="text-xs text-gray-500">横の数字は第何週か（日曜〜土曜）です。棒を押すと、その週の金額と内訳が出ます。</p>
        <div className="mt-2">
          <StackedColumns rows={chartRows} series={series} ariaLabel={`${year}年 週ごとの出荷金額`} height={260} />
        </div>
      </section>

      <section className="mt-4 overflow-x-auto rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">週ごとの集計表</h2>
          <div className="flex items-center gap-3 print:hidden">
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
              52週すべて表示
            </label>
            <button onClick={exportCsv} className="text-sm text-gray-600 underline">
              CSVで書き出す
            </button>
            <button onClick={() => window.print()} className="text-sm text-gray-600 underline">
              印刷
            </button>
          </div>
        </div>
        <table className="mt-2 w-full min-w-[40rem] text-sm tabular-nums">
          <thead>
            <tr className="border-b text-xs text-gray-500">
              <th className="py-1 text-left">週</th>
              <th className="py-1 text-left">期間</th>
              <th className="py-1 text-right">出荷日数</th>
              <th className="py-1 text-right">パック数量</th>
              <th className="py-1 text-right">粒数</th>
              <th className="py-1 text-right">重量kg</th>
              <th className="py-1 text-right">金額</th>
              <th className="py-1 text-right">1パック平均</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.no} className={`border-b last:border-0 ${r.no === best.no ? "bg-berry/5" : ""}`}>
                <td className="py-1">第{r.no}週</td>
                <td className="py-1 text-gray-600">
                  {md(r.from)}〜{md(r.to)}
                </td>
                <td className="py-1 text-right">{r.days || ""}</td>
                <td className="py-1 text-right">{r.packs ? num(r.packs) : ""}</td>
                <td className="py-1 text-right">{r.berries ? num(r.berries) : ""}</td>
                <td className="py-1 text-right">{r.kg ? num(r.kg) : ""}</td>
                <td className="py-1 text-right font-semibold">{r.amount ? num(r.amount) : ""}</td>
                <td className="py-1 text-right text-gray-600">{r.packs ? num(Math.round(r.amount / r.packs)) : ""}</td>
              </tr>
            ))}
            <tr className="border-t-2 font-bold">
              <td className="py-1">合計</td>
              <td />
              <td className="py-1 text-right">{total.days}</td>
              <td className="py-1 text-right">{num(total.packs)}</td>
              <td className="py-1 text-right">{num(total.berries)}</td>
              <td className="py-1 text-right">{num(total.kg)}</td>
              <td className="py-1 text-right">{num(total.amount)}</td>
              <td className="py-1 text-right">{total.packs ? num(Math.round(total.amount / total.packs)) : ""}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-xs text-gray-500">1パック平均は「金額÷パック数量」です（粒売りの金額も含みます）。</p>
      </section>

      <section className="mt-4 overflow-x-auto rounded-2xl bg-white p-4 shadow-sm print:break-before-page print:shadow-none">
        <h2 className="font-bold">規格ごとの数量（週ごと）</h2>
        <table className="mt-2 min-w-max text-xs tabular-nums">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="sticky left-0 bg-white px-2 py-1 text-left">週</th>
              {grades.map((g) => (
                <th key={g.id} className="px-2 py-1 text-right">
                  <div className="font-normal">{g.group}</div>
                  {g.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.no} className="border-b last:border-0">
                <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-1">
                  第{r.no}週 <span className="text-gray-500">{md(r.from)}〜</span>
                </td>
                {grades.map((g) => (
                  <td key={g.id} className="px-2 py-1 text-right">
                    {r.byGrade[g.id] ? num(r.byGrade[g.id]) : ""}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t-2 font-bold">
              <td className="sticky left-0 bg-white px-2 py-1">合計</td>
              {grades.map((g) => (
                <td key={g.id} className="px-2 py-1 text-right">
                  {num(tot((r) => r.byGrade[g.id] ?? 0))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>
      <div className="h-8" />
    </>
  );
}

function Tile({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <div className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${strong ? "text-white/90" : "text-gray-600"}`}>{sub}</div>}
    </div>
  );
}
