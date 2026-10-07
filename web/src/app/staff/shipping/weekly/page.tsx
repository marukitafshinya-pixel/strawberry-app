"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { DayRangePicker, inDayRange, useDayRange } from "@/components/DayRange";
import { Legend, PairedColumns, SERIES_COLORS, StackedColumns, WeatherPicker, WeatherStrip, yenShort, type Series } from "@/components/charts";
import { addDays, todayJST } from "@/lib/date";
import { periodsOf, unitText, type UnitText } from "@/lib/period";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { unitWeight, useShipments, useShippingConfig, type DayItems, type Grade } from "@/lib/shipping";
import { useWeatherMonths, useWeatherShow, weatherOfSpan, type WeatherMonth } from "@/lib/weather";

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

/** 日ごとの出荷を、週（または月）ごとにまとめる */
function computeRows(weeks: { no: number; from: string; to: string }[], days: Record<string, DayItems>, grades: Grade[]): WeekRow[] {
  return weeks.map((w) => {
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
}

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
  const u = unitText(params.get("unit") === "month" ? "month" : params.get("unit") === "day" ? "day" : "week");
  const weeks = useMemo(() => periodsOf(year, u.unit), [year, u.unit]);
  // 第1週は前の年の12月から、最後の週は次の年の1月まで入ることがあるので、その分も読む
  const days = useShipments(weeks[0].from, weeks[weeks.length - 1].to);
  const { value: config } = useShippingConfig();
  const [showEmpty, setShowEmpty] = useState(false);
  const years = Array.from({ length: thisYear - 2023 + 2 }, (_, i) => thisYear + 1 - i);

  // 前年と比べるときは、前年の同じ週（第〇週）どうしを並べる
  const compare = params.get("view") === "compare";
  const prevWeeks = useMemo(() => periodsOf(year - 1, u.unit), [year, u.unit]);
  const prevDays = useShipments(prevWeeks[0].from, prevWeeks[prevWeeks.length - 1].to);
  const data = useMemo(() => {
    if (!days || !config) return null;
    const grades = config.grades;
    const groups = [...new Set(grades.map((g) => g.group))];
    return { rows: computeRows(weeks, days, grades), grades, groups };
  }, [days, config, weeks]);
  const prevRows = useMemo(() => (prevDays && config ? computeRows(prevWeeks, prevDays, config.grades) : null), [prevDays, config, prevWeeks]);
  // 気象データ（グラフの下に並べる）
  // 気象の「前年と比較」用に、前年の分も読む
  const weather = useWeatherMonths(prevWeeks[0].from.slice(0, 7), weeks[weeks.length - 1].to.slice(0, 7));
  const wx = { months: weather, ...useWeatherShow(), year };
  const go = (yy: number, cmp: boolean, unit = u.unit) => router.replace(`/staff/shipping/weekly/?year=${yy}${cmp ? "&view=compare" : ""}${unit !== "week" ? `&unit=${unit}` : ""}`);

  return (
    <>
      <p className="text-sm">
        <Link href={`/staff/shipping/?month=${year === thisYear ? todayJST().slice(0, 7) : `${year}-06`}`} className="text-gray-500 underline">
          ← 出荷実績
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">出荷の実績集計（{u.each}）</h1>
      <div className="mt-3 flex flex-wrap gap-2">
        {years.map((yy) => (
          <button
            key={yy}
            onClick={() => go(yy, compare)}
            className={`rounded-full border px-4 py-2 text-sm ${yy === year ? "border-berry bg-berry font-bold text-white" : "bg-white"}`}
          >
            {yy}年（令和{yy - 2018}年）
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 print:hidden">
      <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">
        <button onClick={() => go(year, compare, "day")} className={`px-4 py-2 ${u.day ? "bg-emerald-700 font-bold text-white" : ""}`}>
          日ごと
        </button>
        <button onClick={() => go(year, compare, "week")} className={`px-4 py-2 ${u.week ? "bg-emerald-700 font-bold text-white" : ""}`}>
          週ごと
        </button>
        <button onClick={() => go(year, compare, "month")} className={`px-4 py-2 ${u.unit === "month" ? "bg-emerald-700 font-bold text-white" : ""}`}>
          月ごと
        </button>
      </div>
      <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">
        <button onClick={() => go(year, false)} className={`px-4 py-2 ${!compare ? "bg-berry font-bold text-white" : ""}`}>
          この年だけ
        </button>
        <button onClick={() => go(year, true)} className={`px-4 py-2 ${compare ? "bg-berry font-bold text-white" : ""}`}>
          前年（{year - 1}年）と比較
        </button>
      </div>
      </div>
      {!data || (compare && !prevRows) ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : compare ? (
        <Compare u={u} year={year} rows={data.rows} prev={prevRows!} wx={wx} />
      ) : (
        <Report u={u} year={year} {...data} prevWeeks={prevWeeks} showEmpty={showEmpty} setShowEmpty={setShowEmpty} wx={wx} />
      )}
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

function Report({
  u,
  year,
  rows,
  grades,
  groups,
  prevWeeks,
  showEmpty,
  setShowEmpty,
  wx,
}: {
  u: UnitText;
  year: number;
  rows: WeekRow[];
  grades: Grade[];
  groups: string[];
  prevWeeks: { no: number; from: string; to: string }[];
  showEmpty: boolean;
  setShowEmpty: (v: boolean) => void;
  wx: WeatherProps;
}) {
  // 日ごとのグラフの範囲（年間・月間・週ごと）
  const dr = useDayRange(year, rows.filter((r) => r.packs + r.berries > 0).at(-1)?.from);
  const withData = rows.filter((r) => r.packs + r.berries > 0);
  if (withData.length === 0) return <p className="mt-4 text-gray-500">{year}年の出荷の記録はまだありません。</p>;
  const tot = (f: (r: WeekRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const total = { packs: tot((r) => r.packs), berries: tot((r) => r.berries), kg: Math.round(tot((r) => r.kg) * 10) / 10, amount: tot((r) => r.amount), days: tot((r) => r.days) };
  // グラフは、出荷があった最初の週から最後の週まで
  const first = rows.indexOf(withData[0]);
  const last = rows.indexOf(withData[withData.length - 1]);
  const chartBase = u.day && dr.range.kind !== "year" ? rows.filter((r) => inDayRange(r.from, dr.range, year)) : rows.slice(first, last + 1);
  const chartRows = chartBase.map((r) => ({ key: String(r.no), label: u.short(r.no), sub: u.week ? `${u.name(r.no)}（${u.span(r)}）` : u.name(r.no), values: r.byGroup }));
  const series: Series[] = groups.map((g, i) => ({ key: g, label: g, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  const shown = showEmpty ? rows : rows.slice(first, last + 1);
  const best = withData.reduce((a, b) => (b.amount > a.amount ? b : a));

  function exportCsv() {
    downloadCsv(`shipping_${u.unit}ly_${year}.csv`, [
      [u.word, "期間", "出荷日数", "パック数量", "粒数", "重量kg", "金額", ...grades.map((g) => `${g.group} ${g.name}`)],
      ...shown.map((r) => [u.name(r.no), `${r.from}〜${r.to}`, r.days, r.packs, r.berries, r.kg, r.amount, ...grades.map((g) => r.byGrade[g.id] ?? "")]),
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
        <Tile label={u.best} value={u.name(best.no)} sub={`${u.week ? `${u.span(best)}・` : ""}${yen(best.amount)}`} />
      </div>

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">{u.each}の出荷金額</h2>
          {u.day && <DayRangePicker year={year} state={dr} />}
          <Legend series={series} />
        </div>
        <p className="text-xs text-gray-500">{u.axisNote}棒を押すと、その{u.word}の金額と内訳が出ます。</p>
        <div className="mt-2">
          <StackedColumns rows={chartRows} series={series} ariaLabel={`${year}年 ${u.each}の出荷金額`} height={260} />
        </div>
        <WeatherPanel u={u} wx={wx} periods={chartBase} prevPeriods={chartBase.map((r) => prevWeeks.find((w) => w.no === r.no))} labels={chartRows} />
      </section>

      <section className="mt-4 overflow-x-auto rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">{u.each}の集計表</h2>
          <div className="flex items-center gap-3 print:hidden">
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
              {u.showAll}
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
              <th className="py-1 text-left">{u.word}</th>
              {u.week && <th className="py-1 text-left">期間</th>}
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
                <td className="py-1">{u.name(r.no)}</td>
                {u.week && <td className="py-1 text-gray-600">{u.span(r)}</td>}
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
              {u.week && <td />}
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
        <h2 className="font-bold">規格ごとの数量（{u.each}）</h2>
        <table className="mt-2 min-w-max text-xs tabular-nums">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="sticky left-0 bg-white px-2 py-1 text-left">{u.word}</th>
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
                  {u.name(r.no)} {u.week && <span className="text-gray-500">{md(r.from)}〜</span>}
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

type Metric = "amount" | "packs" | "berries" | "kg";
const METRICS: { key: Metric; label: string; unit: string }[] = [
  { key: "amount", label: "金額", unit: "円" },
  { key: "packs", label: "パック数量", unit: "" },
  { key: "berries", label: "粒数", unit: "粒" },
  { key: "kg", label: "重量", unit: "kg" },
];

/** 前年との比較（同じ週・同じ月どうし） */
function Compare({ u, year, rows, prev, wx }: { u: UnitText; year: number; rows: WeekRow[]; prev: WeekRow[]; wx: WeatherProps }) {
  const [metric, setMetric] = useState<Metric>("amount");
  const dr = useDayRange(year, rows.filter((r) => r.packs + r.berries > 0).at(-1)?.from);
  const m = METRICS.find((x) => x.key === metric)!;
  const has = (r?: WeekRow) => !!r && r.packs + r.berries > 0;
  const n = Math.max(rows.length, prev.length);
  const all = Array.from({ length: n }, (_, i) => ({ no: i + 1, a: rows[i], b: prev[i] }));
  const active = all.filter((x) => has(x.a) || has(x.b));
  if (active.length === 0) return <p className="mt-4 text-gray-500">{year}年・{year - 1}年とも、出荷の記録がありません。</p>;
  const firstNo = active[0].no;
  const lastNo = active[active.length - 1].no;
  const range = all.filter((x) => x.no >= firstNo && x.no <= lastNo);
  // 日ごとのグラフは、選んだ範囲（年間・月間・週ごと）だけ
  const chartRange = u.day && dr.range.kind !== "year" ? all.filter((x) => x.a && inDayRange(x.a.from, dr.range, year)) : range;
  const val = (r: WeekRow | undefined) => (has(r) ? r![metric] : null);
  const fmt = (v: number) => (metric === "amount" ? `${num(v)}円` : `${num(v)}${m.unit}`);
  const sa = { key: "a", label: `${year}年`, color: SERIES_COLORS[0] };
  const sb = { key: "b", label: `${year - 1}年`, color: SERIES_COLORS[1] };
  const sum = (list: (WeekRow | undefined)[]) => Math.round(list.reduce((t, r) => t + (has(r) ? r![metric] : 0), 0) * 10) / 10;
  const tA = sum(rows);
  const tB = sum(prev);
  const pct = (a: number | null, b: number | null) => (a !== null && b ? `${Math.round((a / b) * 100)}%` : "－");
  const diff = (a: number | null, b: number | null) => (a === null && b === null ? null : Math.round(((a ?? 0) - (b ?? 0)) * 10) / 10);
  const signed = (v: number | null) => (v === null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v))}`);
  const md2 = (r?: WeekRow) => u.span(r);

  function exportCsv() {
    downloadCsv(`shipping_${u.unit}ly_compare_${year}_${year - 1}.csv`, [
      [u.word, `${year}年の期間`, `${year}年 ${m.label}`, `${year - 1}年の期間`, `${year - 1}年 ${m.label}`, "差", "前年比"],
      ...range.map((x) => [u.name(x.no), md2(x.a), val(x.a) ?? "", md2(x.b), val(x.b) ?? "", diff(val(x.a), val(x.b)) ?? "", pct(val(x.a), val(x.b))]),
      ["合計", "", tA, "", tB, diff(tA, tB) ?? "", pct(tA, tB)],
    ]);
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2 print:hidden">
        {METRICS.map((x) => (
          <button key={x.key} onClick={() => setMetric(x.key)} className={`rounded-full border px-4 py-1.5 text-sm ${metric === x.key ? "border-emerald-700 bg-emerald-50 font-bold text-emerald-800" : "bg-white"}`}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Tile label={`${year}年の${m.label}`} value={fmt(tA)} strong />
        <Tile label={`${year - 1}年の${m.label}`} value={fmt(tB)} />
        <Tile label="前年比" value={pct(tA, tB)} sub={signed(diff(tA, tB))} />
      </div>

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">{u.each}の{m.label}（{year}年と{year - 1}年）</h2>
          {u.day && <DayRangePicker year={year} state={dr} />}
          <Legend series={[sa, sb]} />
        </div>
        <p className="text-xs text-gray-500">{u.axisNote}同じ{u.word}どうしを並べています。棒を押すと、その{u.word}の数字と前年比が出ます。</p>
        <div className="mt-2">
          <PairedColumns
            rows={chartRange.map((x) => ({ key: String(x.no), label: u.short(x.no), sub: u.week ? `${u.name(x.no)}（${md2(x.a)}）` : u.name(x.no), a: val(x.a), b: val(x.b) }))}
            a={sa}
            b={sb}
            fmt={fmt}
            axis={(v) => (metric === "amount" ? yenShort(v) : num(v))}
            ariaLabel={`${u.each}の${m.label}の前年との比較`}
            height={260}
          />
        </div>
        <WeatherPanel
          u={u}
          wx={wx}
          padL={48}
          note={wx.compare ? "" : `気象は${year}年の値です。`}
          periods={chartRange.map((x) => x.a)}
          prevPeriods={chartRange.map((x) => x.b)}
          labels={chartRange.map((x) => ({ key: String(x.no), label: u.short(x.no), sub: u.week ? `${u.name(x.no)}（${md2(x.a)}）` : u.name(x.no) }))}
        />
      </section>

      <section className="mt-4 overflow-x-auto rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">前年との比較表（{m.label}）</h2>
          <div className="flex items-center gap-3 print:hidden">
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
              <th className="py-1 text-left">{u.word}</th>
              {u.week && <th className="py-1 text-left">{year}年の期間</th>}
              <th className="py-1 text-right">{year}年</th>
              <th className="py-1 text-right">{year - 1}年</th>
              <th className="py-1 text-right">差</th>
              <th className="py-1 text-right">前年比</th>
            </tr>
          </thead>
          <tbody>
            {range.map((x) => {
              const d = diff(val(x.a), val(x.b));
              return (
                <tr key={x.no} className="border-b last:border-0">
                  <td className="py-1">{u.name(x.no)}</td>
                  {u.week && <td className="py-1 text-gray-600">{md2(x.a)}</td>}
                  <td className="py-1 text-right font-semibold">{val(x.a) === null ? <span className="text-gray-300">－</span> : fmt(val(x.a)!)}</td>
                  <td className="py-1 text-right">{val(x.b) === null ? <span className="text-gray-300">－</span> : fmt(val(x.b)!)}</td>
                  <td className={`py-1 text-right ${d !== null && d < 0 ? "text-red-700" : ""}`}>{signed(d)}</td>
                  <td className="py-1 text-right">{pct(val(x.a), val(x.b))}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 font-bold">
              <td className="py-1">合計</td>
              {u.week && <td />}
              <td className="py-1 text-right">{fmt(tA)}</td>
              <td className="py-1 text-right">{fmt(tB)}</td>
              <td className="py-1 text-right">{signed(diff(tA, tB))}</td>
              <td className="py-1 text-right">{pct(tA, tB)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-xs text-gray-500">「－」はその{u.word}に出荷がなかったことを表します。前年比は「今年÷前年」です。</p>
      </section>
      <div className="h-8" />
    </>
  );
}

type WeatherProps = { months: WeatherMonth[] | null; year: number } & ReturnType<typeof useWeatherShow>;

/** 出荷のグラフの下に、同じ日付（週・月）の気象を並べる。気温・降水量・日照時間は単位が違うので、それぞれ別の段にする */
function WeatherPanel({
  u,
  wx,
  periods,
  prevPeriods,
  labels,
  padL,
  note,
}: {
  u: UnitText;
  wx: WeatherProps;
  periods: ({ from: string; to: string } | undefined)[];
  prevPeriods: ({ from: string; to: string } | undefined)[];
  labels: { key: string; label: string; sub?: string }[];
  padL?: number;
  note?: string;
}) {
  const of = (p?: { from: string; to: string }) => (p && wx.months ? weatherOfSpan(wx.months, p.from, p.to) : {});
  const rows = labels.map((l, i) => ({ ...l, values: of(periods[i]), prev: wx.compare ? of(prevPeriods[i]) : undefined }));
  const any = rows.some((r) => [r.values, r.prev ?? {}].some((x) => Object.values(x).some((v) => typeof v === "number")));
  return (
    <div className="mt-3 border-t pt-3">
      <WeatherPicker show={wx.show} onChange={wx.setShow} compare={wx.compare} onCompare={wx.setCompare} year={wx.year} />
      {wx.show.length > 0 &&
        (!wx.months ? (
          <p className="mt-2 text-xs text-gray-500">気象データを読み込み中…</p>
        ) : !any ? (
          <p className="mt-2 text-xs text-gray-500">
            この期間の気象データがありません。
            <Link href="/staff/weather/" className="underline">
              気象データ
            </Link>
            の画面で取り込んでください。
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-gray-500">
              上の棒と同じ{u.word}の気象です（美瑛のアメダス）。{u.day ? "" : "気温はその期間の平均、降水量・日照時間は合計です。"}
              {note}
            </p>
            <WeatherStrip rows={rows} show={wx.show} padL={padL} compare={wx.compare ? { a: `${wx.year}年`, b: `${wx.year - 1}年` } : undefined} />
          </>
        ))}
    </div>
  );
}
