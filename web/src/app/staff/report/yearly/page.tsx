"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { PairedColumns, SERIES_COLORS, yenShort } from "@/components/charts";
import { useAuth } from "@/lib/auth";
import { todayJST } from "@/lib/date";
import { EMPLOYER_ITEMS, computeRow, usePayrollsRange, type Payroll } from "@/lib/payroll";
import { buildDailySales, downloadCsv, sumValues } from "@/lib/report";
import { countsTowardCapacity, useReservationsRange, useSettings } from "@/lib/reservations";
import { useImportedSales, useSales } from "@/lib/sales";
import type { Settings } from "@/lib/settings";
import { unitWeight, useShipments, useShippingConfig, type DayItems, type Grade } from "@/lib/shipping";

type Tab = "sales" | "people" | "shipping" | "payroll";
type Metric = { key: string; label: string; unit: "円" | "人" | "kg" };

const TABS: { key: Tab; label: string; adminOnly?: boolean }[] = [
  { key: "sales", label: "売上" },
  { key: "people", label: "予約の人数" },
  { key: "shipping", label: "出荷実績" },
  { key: "payroll", label: "給与", adminOnly: true },
];
const METRICS: Record<Tab, Metric[]> = {
  sales: [{ key: "amount", label: "売上", unit: "円" }],
  people: [{ key: "people", label: "予約の人数（キャンセル・リクエストを除く）", unit: "人" }],
  shipping: [
    { key: "amount", label: "出荷金額", unit: "円" },
    { key: "weight", label: "出荷の重さ", unit: "kg" },
  ],
  payroll: [
    { key: "pay", label: "支給合計（労賃）", unit: "円" },
    { key: "net", label: "差引支給額", unit: "円" },
    { key: "employer", label: "事業所負担", unit: "円" },
  ],
};

/** 月ごとの値（1〜12月）。null はデータなし */
type Months = (number | null)[];
const emptyMonths = (): Months => Array(12).fill(null);
const add = (m: Months, month: number, v: number) => {
  m[month - 1] = (m[month - 1] ?? 0) + v;
};

export default function YearlyPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <YearlyView />
    </Suspense>
  );
}

function YearlyView() {
  const params = useSearchParams();
  const router = useRouter();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const thisYear = Number(todayJST().slice(0, 4));
  const num = (k: string, d: number) => {
    const v = Number(params.get(k));
    return Number.isInteger(v) && v >= 2000 && v <= 2100 ? v : d;
  };
  const yearA = num("a", thisYear);
  const yearB = num("b", yearA - 1);
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.some((t) => t.key === tabParam && (!t.adminOnly || isAdmin)) ? tabParam : "sales";
  const metrics = METRICS[tab];
  const metric = metrics.find((m) => m.key === params.get("m")) ?? metrics[0];
  const go = (p: Partial<{ a: number; b: number; tab: Tab; m: string }>) => {
    const q = { a: yearA, b: yearB, tab, m: metric.key, ...p };
    if (p.tab && p.tab !== tab) q.m = METRICS[p.tab][0].key;
    router.replace(`/staff/report/yearly/?a=${q.a}&b=${q.b}&tab=${q.tab}&m=${q.m}`);
  };

  const { value: settings } = useSettings();
  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  const years = Array.from({ length: thisYear - 2019 + 2 }, (_, i) => thisYear + 1 - i);
  return (
    <>
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">年ごとの比較</h1>
        <button onClick={() => window.print()} className="rounded-lg border bg-white px-3 py-2 text-sm print:hidden">
          印刷
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm print:p-0 print:shadow-none">
        <YearSelect value={yearA} years={years} color={SERIES_COLORS[0]} onChange={(a) => go({ a })} />
        <span className="text-gray-500">と</span>
        <YearSelect value={yearB} years={years} color={SERIES_COLORS[1]} onChange={(b) => go({ b })} />
        <span className="text-gray-500">を比べる</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 print:hidden">
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <button
            key={t.key}
            onClick={() => go({ tab: t.key })}
            className={`rounded-full border px-4 py-2 text-sm ${tab === t.key ? "border-berry bg-berry font-bold text-white" : "bg-white"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {metrics.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-3 text-sm print:hidden">
          {metrics.map((m) => (
            <label key={m.key} className="flex items-center gap-1">
              <input type="radio" checked={metric.key === m.key} onChange={() => go({ m: m.key })} />
              {m.label}
            </label>
          ))}
        </div>
      )}

      {/* 年や項目を変えたら作り直す（前のデータが混ざらないように） */}
      <Loader key={`${tab}_${yearA}_${yearB}`} tab={tab} metric={metric} yearA={yearA} yearB={yearB} settings={settings} isAdmin={isAdmin} />
      <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

function YearSelect({ value, years, color, onChange }: { value: number; years: number[]; color: string; onChange: (y: number) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="inline-block h-3 w-3 rounded-sm" style={{ background: color }} />
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="rounded-lg border px-2 py-2 text-base">
        {years.map((y) => (
          <option key={y} value={y}>
            {y}年
          </option>
        ))}
      </select>
    </label>
  );
}

/** 選んだ項目のデータを2年分読み込み、月ごとにまとめる */
function Loader(props: { tab: Tab; metric: Metric; yearA: number; yearB: number; settings: Settings; isAdmin: boolean }) {
  const { tab } = props;
  if (tab === "sales") return <SalesYears {...props} />;
  if (tab === "people") return <PeopleYears {...props} />;
  if (tab === "shipping") return <ShippingYears {...props} />;
  return <PayrollYears {...props} />;
}

type Props = { metric: Metric; yearA: number; yearB: number; settings: Settings; isAdmin: boolean };
const span = (a: number, b: number) => ({ from: `${Math.min(a, b)}-01-01`, to: `${Math.max(a, b)}-12-31` });

function SalesYears({ metric, yearA, yearB, settings }: Props) {
  const { from, to } = span(yearA, yearB);
  const { value: sales } = useSales(from, to);
  const { value: imported } = useImportedSales(from, to);
  const data = useMemo(() => {
    if (!sales || !imported) return null;
    const { byDay } = buildDailySales(settings, sales, imported);
    const out: Record<number, Months> = { [yearA]: emptyMonths(), [yearB]: emptyMonths() };
    for (const [d, v] of byDay) {
      const y = Number(d.slice(0, 4));
      if (out[y]) add(out[y], Number(d.slice(5, 7)), sumValues(v));
    }
    return out;
  }, [sales, imported, settings, yearA, yearB]);
  return <Compare data={data} metric={metric} yearA={yearA} yearB={yearB} note="アプリで会計した日はその合計、会計がない日は取り込んだ売上（Airレジなど）を使っています。" />;
}

function PeopleYears({ metric, yearA, yearB }: Props) {
  const { from, to } = span(yearA, yearB);
  const { value: reservations } = useReservationsRange(from, to);
  const data = useMemo(() => {
    if (!reservations) return null;
    const out: Record<number, Months> = { [yearA]: emptyMonths(), [yearB]: emptyMonths() };
    for (const r of reservations) {
      if (!countsTowardCapacity(r.status)) continue;
      const y = Number(r.date.slice(0, 4));
      if (out[y]) add(out[y], Number(r.date.slice(5, 7)), r.people);
    }
    return out;
  }, [reservations, yearA, yearB]);
  return <Compare data={data} metric={metric} yearA={yearA} yearB={yearB} note="アプリに入っている予約の人数です（キャンセルと承認前のリクエストは数えていません）。" />;
}

function ShippingYears({ metric, yearA, yearB }: Props) {
  const { from, to } = span(yearA, yearB);
  const days = useShipments(from, to);
  const { value: config } = useShippingConfig();
  const data = useMemo(() => {
    if (!days || !config) return null;
    const grades = new Map<string, Grade>(config.grades.map((g) => [g.id, g]));
    const out: Record<number, Months> = { [yearA]: emptyMonths(), [yearB]: emptyMonths() };
    for (const [d, items] of Object.entries(days) as [string, DayItems][]) {
      const y = Number(d.slice(0, 4));
      if (!out[y]) continue;
      let v = 0;
      for (const [id, it] of Object.entries(items)) {
        if (!it.qty) continue;
        if (metric.key === "amount") v += it.qty * (it.price ?? 0);
        else {
          const g = grades.get(id);
          if (g) v += (it.qty * unitWeight(g)) / 1000;
        }
      }
      add(out[y], Number(d.slice(5, 7)), v);
    }
    // 重さは小数1けたにそろえる
    if (metric.key === "weight") for (const m of Object.values(out)) m.forEach((x, i) => (m[i] = x === null ? null : Math.round(x * 10) / 10));
    return out;
  }, [days, config, metric.key, yearA, yearB]);
  return (
    <Compare
      data={data}
      metric={metric}
      yearA={yearA}
      yearB={yearB}
      note={metric.key === "amount" ? "出荷実績に入れた数量×単価の合計です（単価が入っていない日は0円として数えます）。" : "数量×規格の重さ（粒数×1粒の平均）の合計です。"}
    />
  );
}

function PayrollYears({ metric, yearA, yearB, isAdmin }: Props) {
  const lo = Math.min(yearA, yearB);
  const hi = Math.max(yearA, yearB);
  const payrolls = usePayrollsRange(`${lo}-01`, `${hi}-12`, isAdmin);
  const data = useMemo(() => {
    if (!payrolls) return null;
    const out: Record<number, Months> = { [yearA]: emptyMonths(), [yearB]: emptyMonths() };
    for (const [month, p] of Object.entries(payrolls) as [string, Payroll][]) {
      const y = Number(month.slice(0, 4));
      if (!out[y]) continue;
      const rows = Object.values(p.rows ?? {}).map(computeRow);
      const v =
        metric.key === "pay"
          ? rows.reduce((n, r) => n + r.pay, 0)
          : metric.key === "net"
            ? rows.reduce((n, r) => n + r.net, 0)
            : EMPLOYER_ITEMS.reduce((n, it) => n + (p.employer?.[it.key] ?? 0), 0);
      add(out[y], Number(month.slice(5, 7)), v);
    }
    return out;
  }, [payrolls, metric.key, yearA, yearB]);
  if (!isAdmin) return <p className="mt-4">給与は管理者だけが見られます。</p>;
  return <Compare data={data} metric={metric} yearA={yearA} yearB={yearB} note="「〇月度分」の給与を、その月として数えています。" />;
}

/** グラフと表（1〜12月、合計、差、前年比） */
function Compare({ data, metric, yearA, yearB, note }: { data: Record<number, Months> | null; metric: Metric; yearA: number; yearB: number; note: string }) {
  if (!data) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  const A = data[yearA];
  const B = data[yearB];
  const fmt = (v: number) =>
    metric.unit === "円" ? `${v.toLocaleString("ja-JP")}円` : `${v.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}${metric.unit}`;
  const axis = (v: number) => (metric.unit === "円" ? yenShort(v) : v.toLocaleString("ja-JP", { maximumFractionDigits: 1 }));
  const total = (m: Months) => (m.some((x) => x !== null) ? m.reduce<number>((n, x) => n + (x ?? 0), 0) : null);
  const tA = total(A);
  const tB = total(B);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const diff = (a: number | null, b: number | null) => (a === null && b === null ? null : round1((a ?? 0) - (b ?? 0)));
  const pct = (a: number | null, b: number | null) => (a !== null && b ? `${Math.round((a / b) * 100)}%` : "－");
  const sa = { key: "a", label: `${yearA}年`, color: SERIES_COLORS[0] };
  const sb = { key: "b", label: `${yearB}年`, color: SERIES_COLORS[1] };
  const rows = A.map((_, i) => ({ key: String(i + 1), label: `${i + 1}月`, a: A[i], b: B[i] }));
  const cell = (v: number | null) => (v === null ? <span className="text-gray-300">－</span> : fmt(v));
  const signed = (v: number | null) => (v === null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v))}`);

  function exportCsv() {
    downloadCsv(`yearly_${metric.key}_${yearA}_${yearB}.csv`, [
      ["月", `${yearA}年`, `${yearB}年`, "差", `${yearB}年比`],
      ...rows.map((r) => [r.label, r.a ?? "", r.b ?? "", diff(r.a, r.b) ?? "", pct(r.a, r.b)]),
      ["合計", tA ?? "", tB ?? "", diff(tA, tB) ?? "", pct(tA, tB)],
    ]);
  }

  return (
    <section className="mt-4 rounded-2xl bg-white p-3 shadow-sm print:p-0 print:shadow-none">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">
          {metric.label}（{yearA}年と{yearB}年）
        </h2>
        <button onClick={exportCsv} className="text-sm text-gray-600 underline print:hidden">
          CSVで書き出す
        </button>
      </div>
      {/* 合計の比較 */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-gray-50 p-2">
          <div className="text-xs text-gray-600">{yearA}年の合計</div>
          <div className="text-sm font-bold sm:text-lg">{cell(tA)}</div>
        </div>
        <div className="rounded-xl bg-gray-50 p-2">
          <div className="text-xs text-gray-600">{yearB}年の合計</div>
          <div className="text-sm font-bold sm:text-lg">{cell(tB)}</div>
        </div>
        <div className="rounded-xl bg-gray-50 p-2">
          <div className="text-xs text-gray-600">{yearB}年比</div>
          <div className="text-sm font-bold sm:text-lg">{pct(tA, tB)}</div>
          <div className="text-xs text-gray-600">{signed(diff(tA, tB))}</div>
        </div>
      </div>

      <div className="mt-3 flex gap-4 text-xs text-gray-700">
        {[sa, sb].map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <PairedColumns rows={rows} a={sa} b={sb} fmt={fmt} axis={axis} ariaLabel={`${metric.label}の月ごとの比較`} />

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs tabular-nums sm:text-sm">
          <thead>
            <tr className="border-b text-xs text-gray-600">
              <th className="px-1 py-1 sm:px-2 text-left font-semibold">月</th>
              <th className="px-1 py-1 sm:px-2 text-right font-semibold">{yearA}年</th>
              <th className="px-1 py-1 sm:px-2 text-right font-semibold">{yearB}年</th>
              <th className="px-1 py-1 sm:px-2 text-right font-semibold">差</th>
              <th className="px-1 py-1 sm:px-2 text-right font-semibold">{yearB}年比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = diff(r.a, r.b);
              return (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="px-1 py-1 sm:px-2">{r.label}</td>
                  <td className="px-1 py-1 sm:px-2 text-right">{cell(r.a)}</td>
                  <td className="px-1 py-1 sm:px-2 text-right">{cell(r.b)}</td>
                  <td className={`px-1 py-1 sm:px-2 text-right ${d !== null && d < 0 ? "text-red-700" : ""}`}>{signed(d)}</td>
                  <td className="px-1 py-1 sm:px-2 text-right">{pct(r.a, r.b)}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 font-bold">
              <td className="px-1 py-1 sm:px-2">合計</td>
              <td className="px-1 py-1 sm:px-2 text-right">{cell(tA)}</td>
              <td className="px-1 py-1 sm:px-2 text-right">{cell(tB)}</td>
              <td className="px-1 py-1 sm:px-2 text-right">{signed(diff(tA, tB))}</td>
              <td className="px-1 py-1 sm:px-2 text-right">{pct(tA, tB)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">{note}「－」はデータがない月です。</p>
    </section>
  );
}
