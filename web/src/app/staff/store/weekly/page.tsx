"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Legend, NEUTRAL, PairedColumns, SERIES_COLORS, StackedColumns, yenShort, type Series } from "@/components/charts";
import { addDays, todayJST } from "@/lib/date";
import { periodsOf, unitText, type UnitText } from "@/lib/period";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { STORE_ITEMS, STORE_KEYS, useStoreDays, type StoreDay, type StoreKey } from "@/lib/store";

const num = (n: number) => n.toLocaleString("ja-JP");

type WeekRow = { no: number; from: string; to: string; v: Record<StoreKey, number>; days: number };

/** 日ごとの店舗実績を、週（または月）ごとにまとめる */
function computeRows(weeks: { no: number; from: string; to: string }[], days: Record<string, StoreDay>): WeekRow[] {
  return weeks.map((w) => {
    const r: WeekRow = { ...w, v: Object.fromEntries(STORE_KEYS.map((k) => [k, 0])) as Record<StoreKey, number>, days: 0 };
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      const day = days[d];
      if (!day) continue;
      let any = false;
      for (const k of STORE_KEYS) {
        if (!day[k]) continue;
        r.v[k] += day[k]!;
        any = true;
      }
      if (any) r.days++;
    }
    return r;
  });
}
const hasData = (r?: WeekRow) => !!r && r.days > 0;
/** 客単価（売上合計÷客数（合計）） */
const perCustomer = (sales: number, customers: number) => (customers ? Math.round(sales / customers) : 0);

export default function StoreWeeklyPage() {
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
  const u = unitText(params.get("unit") === "month" ? "month" : "week");
  const weeks = useMemo(() => periodsOf(year, u.unit), [year, u.unit]);
  // 第1週は前の年の12月から、最後の週は次の年の1月まで入ることがあるので、その分も読む
  const days = useStoreDays(weeks[0].from, weeks[weeks.length - 1].to);
  const [showEmpty, setShowEmpty] = useState(false);
  const years = Array.from({ length: thisYear - 2023 + 2 }, (_, i) => thisYear + 1 - i);

  // 前年と比べるときは、前年の同じ週（第〇週）どうしを並べる
  const compare = params.get("view") === "compare";
  const prevWeeks = useMemo(() => periodsOf(year - 1, u.unit), [year, u.unit]);
  const prevDays = useStoreDays(prevWeeks[0].from, prevWeeks[prevWeeks.length - 1].to);
  const rows = useMemo(() => (days ? computeRows(weeks, days) : null), [days, weeks]);
  const prevRows = useMemo(() => (prevDays ? computeRows(prevWeeks, prevDays) : null), [prevDays, prevWeeks]);
  const go = (yy: number, cmp: boolean, unit = u.unit) => router.replace(`/staff/store/weekly/?year=${yy}${cmp ? "&view=compare" : ""}${unit === "month" ? "&unit=month" : ""}`);

  return (
    <>
      <p className="text-sm">
        <Link href={`/staff/store/?month=${year === thisYear ? todayJST().slice(0, 7) : `${year}-06`}`} className="text-gray-500 underline">
          ← 店舗実績
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">店舗の実績集計（{u.each}）</h1>
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
        <button onClick={() => go(year, compare, "week")} className={`px-4 py-2 ${u.week ? "bg-emerald-700 font-bold text-white" : ""}`}>
          週ごと
        </button>
        <button onClick={() => go(year, compare, "month")} className={`px-4 py-2 ${!u.week ? "bg-emerald-700 font-bold text-white" : ""}`}>
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
      {!rows || (compare && !prevRows) ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : compare ? (
        <Compare u={u} year={year} rows={rows} prev={prevRows!} />
      ) : (
        <Report u={u} year={year} rows={rows} showEmpty={showEmpty} setShowEmpty={setShowEmpty} />
      )}
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

// 表の列（売上と客数を組にして並べる）
const COLS: { key: StoreKey; head: string; sub?: string }[] = [
  { key: "direct", head: "直売", sub: "売上" },
  { key: "directCustomers", head: "", sub: "客数" },
  { key: "cafe", head: "カフェ", sub: "売上" },
  { key: "cafeCustomers", head: "", sub: "客数" },
  { key: "ichigo", head: "いちご狩り", sub: "売上" },
  { key: "ichigoCustomers", head: "", sub: "客数" },
  { key: "total", head: "合計", sub: "売上" },
  { key: "totalCustomers", head: "", sub: "客数" },
];

function Report({ u, year, rows, showEmpty, setShowEmpty }: { u: UnitText; year: number; rows: WeekRow[]; showEmpty: boolean; setShowEmpty: (v: boolean) => void }) {
  const withData = rows.filter(hasData);
  if (withData.length === 0) return <p className="mt-4 text-gray-500">{year}年の店舗実績の記録はまだありません。</p>;
  const tot = (k: StoreKey) => rows.reduce((n, r) => n + r.v[k], 0);
  const total = Object.fromEntries(STORE_KEYS.map((k) => [k, tot(k)])) as Record<StoreKey, number>;
  const totalDays = rows.reduce((n, r) => n + r.days, 0);
  // グラフと表は、記録があった最初の週から最後の週まで
  const first = rows.indexOf(withData[0]);
  const last = rows.indexOf(withData[withData.length - 1]);
  const shown = showEmpty ? rows : rows.slice(first, last + 1);
  const best = withData.reduce((a, b) => (b.v.total > a.v.total ? b : a));

  // 直売・カフェ・いちご狩りを積み上げる。売上合計のほうが多い分は「その他（内訳なし）」として足す
  const series: Series[] = [
    { key: "direct", label: "直売", color: SERIES_COLORS[0] },
    { key: "cafe", label: "カフェ", color: SERIES_COLORS[1] },
    { key: "ichigo", label: "いちご狩り", color: SERIES_COLORS[2] },
    { key: "other", label: "その他（内訳なし）", color: NEUTRAL },
  ];
  const chartRows = rows.slice(first, last + 1).map((r) => {
    const parts = r.v.direct + r.v.cafe + r.v.ichigo;
    return {
      key: String(r.no),
      label: u.week ? `${r.no}` : `${r.no}月`,
      sub: u.week ? `${u.name(r.no)}（${u.span(r)}）` : u.name(r.no),
      values: { direct: r.v.direct, cafe: r.v.cafe, ichigo: r.v.ichigo, other: Math.max(0, r.v.total - parts) },
    };
  });
  const usedSeries = series.filter((s) => chartRows.some((r) => (r.values as Record<string, number>)[s.key] > 0));

  function exportCsv() {
    downloadCsv(`store_${u.unit}ly_${year}.csv`, [
      [u.word, "期間", "営業日数", ...STORE_ITEMS.map((i) => i.label), "客単価"],
      ...shown.map((r) => [u.name(r.no), `${r.from}〜${r.to}`, r.days, ...STORE_KEYS.map((k) => r.v[k] || ""), perCustomer(r.v.total, r.v.totalCustomers) || ""]),
      ["合計", "", totalDays, ...STORE_KEYS.map((k) => total[k]), perCustomer(total.total, total.totalCustomers) || ""],
    ]);
  }

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label={`${year}年の売上合計`} value={yen(total.total)} strong />
        <Tile label="客数（合計）" value={`${num(total.totalCustomers)}人`} />
        <Tile label="客単価" value={total.totalCustomers ? yen(perCustomer(total.total, total.totalCustomers)) : "－"} />
        <Tile label="値引額" value={yen(total.discount)} />
        <Tile label={u.week ? "いちばん売れた週" : "いちばん売れた月"} value={u.name(best.no)} sub={`${u.week ? `${u.span(best)}・` : ""}${yen(best.v.total)}`} />
      </div>

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">{u.each}の売上</h2>
          <Legend series={usedSeries} />
        </div>
        <p className="text-xs text-gray-500">
          {u.axisNote}棒を押すと、その{u.word}の金額と内訳が出ます。売上合計が直売・カフェ・いちご狩りの合計より多い分は「その他（内訳なし）」です。
        </p>
        <div className="mt-2">
          <StackedColumns rows={chartRows} series={usedSeries} ariaLabel={`${year}年 ${u.each}の店舗の売上`} height={260} />
        </div>
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
        <table className="mt-2 w-full min-w-[56rem] text-sm tabular-nums">
          <thead>
            <tr className="text-xs text-gray-500">
              <th className="py-1 text-left" rowSpan={2}>
                {u.word}
              </th>
              {u.week && (
                <th className="py-1 text-left" rowSpan={2}>
                  期間
                </th>
              )}
              <th className="py-1 text-right" rowSpan={2}>
                営業日数
              </th>
              {COLS.filter((c) => c.head).map((c) => (
                <th key={c.key} colSpan={2} className="border-l py-1 text-center">
                  {c.head}
                </th>
              ))}
              <th className="border-l py-1 text-right" rowSpan={2}>
                客単価
              </th>
              <th className="border-l py-1 text-right" rowSpan={2}>
                値引額
              </th>
            </tr>
            <tr className="border-b text-xs text-gray-500">
              {COLS.map((c) => (
                <th key={c.key} className={`py-1 text-right ${c.head ? "border-l" : ""}`}>
                  {c.sub}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.no} className={`border-b last:border-0 ${r.no === best.no ? "bg-berry/5" : ""}`}>
                <td className="whitespace-nowrap py-1">{u.name(r.no)}</td>
                {u.week && <td className="whitespace-nowrap py-1 text-gray-600">{u.span(r)}</td>}
                <td className="py-1 text-right">{r.days || ""}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={`py-1 pl-2 text-right ${c.head ? "border-l" : "text-gray-600"} ${c.key === "total" ? "font-semibold" : ""}`}>
                    {r.v[c.key] ? num(r.v[c.key]) : ""}
                  </td>
                ))}
                <td className="border-l py-1 pl-2 text-right text-gray-600">{r.v.totalCustomers ? num(perCustomer(r.v.total, r.v.totalCustomers)) : ""}</td>
                <td className="border-l py-1 pl-2 text-right">{r.v.discount ? num(r.v.discount) : ""}</td>
              </tr>
            ))}
            <tr className="border-t-2 font-bold">
              <td className="py-1">合計</td>
              {u.week && <td />}
              <td className="py-1 text-right">{totalDays}</td>
              {COLS.map((c) => (
                <td key={c.key} className={`py-1 pl-2 text-right ${c.head ? "border-l" : ""}`}>
                  {num(total[c.key])}
                </td>
              ))}
              <td className="border-l py-1 pl-2 text-right">{total.totalCustomers ? num(perCustomer(total.total, total.totalCustomers)) : ""}</td>
              <td className="border-l py-1 pl-2 text-right">{num(total.discount)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-xs text-gray-500">金額は円です。営業日数は、その{u.word}に数字が入っている日の数です。客単価は「売上合計÷客数（合計）」です。</p>
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

// 比べる項目（売上合計を先頭に）
const METRICS: { key: StoreKey; label: string; unit: "円" | "人" }[] = [
  { key: "total", label: "売上合計", unit: "円" },
  { key: "totalCustomers", label: "客数（合計）", unit: "人" },
  { key: "direct", label: "直売売上", unit: "円" },
  { key: "directCustomers", label: "客数（直売）", unit: "人" },
  { key: "cafe", label: "カフェ売上", unit: "円" },
  { key: "cafeCustomers", label: "客数（カフェ）", unit: "人" },
  { key: "ichigo", label: "いちご狩り売上", unit: "円" },
  { key: "ichigoCustomers", label: "客数（いちご狩り）", unit: "人" },
  { key: "discount", label: "値引額", unit: "円" },
];

/** 前年との比較（同じ週・同じ月どうし） */
function Compare({ u, year, rows, prev }: { u: UnitText; year: number; rows: WeekRow[]; prev: WeekRow[] }) {
  const [metric, setMetric] = useState<StoreKey>("total");
  const m = METRICS.find((x) => x.key === metric)!;
  const n = Math.max(rows.length, prev.length);
  const all = Array.from({ length: n }, (_, i) => ({ no: i + 1, a: rows[i], b: prev[i] }));
  const active = all.filter((x) => hasData(x.a) || hasData(x.b));
  if (active.length === 0) return <p className="mt-4 text-gray-500">{year}年・{year - 1}年とも、店舗実績の記録がありません。</p>;
  const firstNo = active[0].no;
  const lastNo = active[active.length - 1].no;
  const range = all.filter((x) => x.no >= firstNo && x.no <= lastNo);
  const val = (r: WeekRow | undefined) => (hasData(r) ? r!.v[metric] : null);
  const fmt = (v: number) => `${num(v)}${m.unit}`;
  const sa = { key: "a", label: `${year}年`, color: SERIES_COLORS[0] };
  const sb = { key: "b", label: `${year - 1}年`, color: SERIES_COLORS[1] };
  const sum = (list: (WeekRow | undefined)[]) => list.reduce((t, r) => t + (val(r) ?? 0), 0);
  const tA = sum(rows);
  const tB = sum(prev);
  const pct = (a: number | null, b: number | null) => (a !== null && b ? `${Math.round((a / b) * 100)}%` : "－");
  const diff = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) - (b ?? 0));
  const signed = (v: number | null) => (v === null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v))}`);
  const md2 = (r?: WeekRow) => u.span(r);

  function exportCsv() {
    downloadCsv(`store_${u.unit}ly_compare_${year}_${year - 1}.csv`, [
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
          <h2 className="font-bold">
            {u.each}の{m.label}（{year}年と{year - 1}年）
          </h2>
          <Legend series={[sa, sb]} />
        </div>
        <p className="text-xs text-gray-500">{u.axisNote}同じ{u.word}どうしを並べています。棒を押すと、その{u.word}の数字と前年比が出ます。</p>
        <div className="mt-2">
          <PairedColumns
            rows={range.map((x) => ({ key: String(x.no), label: u.week ? String(x.no) : `${x.no}月`, sub: u.week ? `${u.name(x.no)}（${md2(x.a)}）` : u.name(x.no), a: val(x.a), b: val(x.b) }))}
            a={sa}
            b={sb}
            fmt={fmt}
            axis={(v) => (m.unit === "円" ? yenShort(v) : num(v))}
            ariaLabel={`${u.each}の${m.label}の前年との比較`}
            height={260}
          />
        </div>
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
        <p className="mt-1 text-xs text-gray-500">「－」はその{u.word}に記録がなかったことを表します。前年比は「今年÷前年」です。</p>
      </section>
      <div className="h-8" />
    </>
  );
}
