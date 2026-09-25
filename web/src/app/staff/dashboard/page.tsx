"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { MAX_DAYS, RangePicker, useRangeParams } from "@/components/RangePicker";
import { HBars, Meter, SeriesToggle, StackedColumns, type Series } from "@/components/charts";
import { buildDailySales } from "@/lib/report";
import { addDays, todayJST, weekday } from "@/lib/date";
import {
  capacityOf,
  countsTowardCapacity,
  useDailyCapacity,
  usePendingRequests,
  useReservations,
  useSettings,
  yen,
} from "@/lib/reservations";
import { useImportedSales, useReceivables, useSales } from "@/lib/sales";

/** "YYYY-MM" を n か月ずらす */
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const lastDay = (ym: string) => addDays(`${shiftMonth(ym, 1)}-01`, -1);

/** 日ごとのグラフにする最長の日数（これより長い期間は月ごとにまとめる） */
const DAILY_MAX = 62;

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const today = todayJST();
  // 期間（画面のアドレスに持たせる。はじめは今月の1日〜今日）
  const range = useRangeParams("/staff/dashboard/");
  const rangeFrom = range.from;
  const rangeTo = range.tooLong ? addDays(range.from, MAX_DAYS - 1) : range.to;
  const endMonth = rangeTo.slice(0, 7);
  // 月ごとのグラフ（期間の終わりまでの直近6か月）の分も合わせて読み込む
  const sixFrom = `${shiftMonth(endMonth, -5)}-01`;
  const from = sixFrom < rangeFrom ? sixFrom : rangeFrom;
  const to = lastDay(endMonth);

  const { value: settings } = useSettings();
  const { value: sales } = useSales(from, to);
  const { value: imported } = useImportedSales(from, to);
  const { value: openReceivables } = useReceivables("open");
  const { value: todayReservations } = useReservations(today);
  const { value: todayCapacity } = useDailyCapacity(today);
  const { value: requests } = usePendingRequests(today);
  const [showTable, setShowTable] = useState(false);
  /** グラフから外している分類 */
  const [hidden, setHidden] = useState<string[]>([]);

  const data = useMemo(
    () => (settings && sales && imported ? buildDailySales(settings, sales, imported) : null),
    [settings, sales, imported],
  );

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  // 選んだ期間の日ごと
  const days: string[] = [];
  for (let d = rangeFrom; d <= rangeTo; d = addDays(d, 1)) days.push(d);
  const dayRows = days.map((d) => ({
    key: d,
    label: days.length > 31 ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : String(Number(d.slice(8))),
    sub: `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${weekday(d)}）`,
    values: data?.byDay.get(d) ?? {},
  }));
  // 長い期間は月ごとにまとめて1本ずつ
  const daily = days.length <= DAILY_MAX;
  const rangeMonths = [...new Set(days.map((d) => d.slice(0, 7)))];
  const rangeMonthRows = rangeMonths.map((m) => {
    const values: Record<string, number> = {};
    for (const r of dayRows) if (r.key.startsWith(m)) for (const [k, n] of Object.entries(r.values)) values[k] = (values[k] ?? 0) + n;
    return { key: m, label: `${Number(m.slice(5))}月`, sub: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, values };
  });
  const mainRows = daily ? dayRows : rangeMonthRows;
  const yearPrefix = rangeFrom.slice(0, 4) === today.slice(0, 4) && rangeTo.slice(0, 4) === today.slice(0, 4) ? "" : `${rangeFrom.slice(0, 4)}年 `;
  const periodLabel =
    yearPrefix +
    (rangeFrom.slice(0, 7) === rangeTo.slice(0, 7) && rangeFrom.endsWith("-01") && rangeTo === lastDay(endMonth)
      ? `${Number(endMonth.slice(5))}月`
      : `${Number(rangeFrom.slice(5, 7))}/${Number(rangeFrom.slice(8))}〜${Number(rangeTo.slice(5, 7))}/${Number(rangeTo.slice(8))}`);
  const sum = (v: Record<string, number>) => Object.values(v).reduce((n, x) => n + x, 0);
  const monthTotal = dayRows.reduce((n, r) => n + sum(r.values), 0);
  // 凡例はこの月に出てくる分類だけ（色は月をまたいでも同じ）
  const monthSeries = (data?.series ?? []).filter((s) => dayRows.some((r) => (r.values[s.key] ?? 0) > 0));
  const shownDay = monthSeries.filter((s) => !hidden.includes(s.key));
  const shownTotal = dayRows.reduce((n, r) => n + shownDay.reduce((m, s) => m + (r.values[s.key] ?? 0), 0), 0);

  // 分類ごと（選んだ月）
  const catTotals = (data?.series ?? [])
    .map((s) => ({ key: s.key, label: s.label, color: s.color, value: dayRows.reduce((n, r) => n + (r.values[s.key] ?? 0), 0) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);

  // 月ごと（期間の終わりまでの直近6か月）
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(endMonth, i - 5));
  const monthRows = months.map((m) => {
    const values: Record<string, number> = {};
    for (const [d, v] of data?.byDay ?? []) if (d.startsWith(m)) for (const [k, n] of Object.entries(v)) values[k] = (values[k] ?? 0) + n;
    return { key: m, label: `${Number(m.slice(5))}月`, sub: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, values };
  });
  const monthlySeries = (data?.series ?? []).filter((s) => monthRows.some((r) => (r.values[s.key] ?? 0) > 0));
  const shownMonthly = monthlySeries.filter((s) => !hidden.includes(s.key));
  const shownSum = (v: Record<string, number>, list: Series[]) => list.reduce((n, s) => n + (v[s.key] ?? 0), 0);

  // 今日の予約
  const activeToday = (todayReservations ?? []).filter((r) => countsTowardCapacity(r.status));
  const openTotal = (openReceivables ?? []).reduce((n, r) => n + r.amount, 0);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">ダッシュボード</h1>

      {/* 今日と全体の数字 */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="今日の予約" value={`${activeToday.length}件`} sub={`${activeToday.reduce((n, r) => n + r.people, 0)}人`} href={`/staff/reservations/?date=${today}`} />
        <Tile label={`売上（${periodLabel}）`} value={yen(monthTotal)} href={`/staff/report/?from=${rangeFrom}&to=${rangeTo}`} />
        <Tile label="未回収の売掛" value={yen(openTotal)} sub={`${openReceivables?.length ?? 0}件`} href="/staff/receivables/" />
        <Tile label="承認待ちのリクエスト" value={`${requests?.length ?? 0}件`} href={`/staff/reservations/?date=${today}`} />
      </div>

      {/* 今日の時間枠 */}
      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">今日の時間枠の埋まり具合</h2>
        <ul className="mt-3 space-y-2">
          {settings.timeSlots.map((t) => {
            const cap = capacityOf(settings, todayCapacity, t.id) ?? t.capacity;
            const booked = activeToday.filter((r) => r.slotId === t.id).reduce((n, r) => n + r.people, 0);
            return (
              <li key={t.id} className="grid grid-cols-[3.5rem_1fr_7rem] items-center gap-3 text-sm">
                <span className="font-semibold">{t.time}</span>
                <Meter value={booked} max={cap} />
                <span className="text-right tabular-nums">
                  {booked} / {cap}人{booked > cap && <span className="ml-1 text-red-700">超過</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 期間の選択 */}
      <RangePicker settings={settings} from={range.from} to={range.to} days={range.days} onChange={range.setRange} />
      {range.tooLong && <p className="mt-2 text-sm text-amber-700">期間が長すぎるので、始めの{MAX_DAYS}日分を表示しています。</p>}
      <div className="mt-3 flex justify-end">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} />
          表で見る
        </label>
      </div>

      {!data ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <section className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-bold">{daily ? "日ごとの売上" : "月ごとの売上（期間内）"}</h2>
              <span className="text-sm text-gray-600">
                合計 {yen(monthTotal)}
                {hidden.length > 0 && <b className="ml-2 text-gray-900">表示中 {yen(shownTotal)}</b>}
              </span>
            </div>
            <div className="mt-2">
              <SeriesToggle series={[...new Map([...monthSeries, ...monthlySeries].map((s) => [s.key, s])).values()]} hidden={hidden} onChange={setHidden} />
            </div>
            {monthTotal === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">この期間の売上はまだありません</p>
            ) : (
              <div className="mt-2">
                <StackedColumns rows={mainRows} series={shownDay} ariaLabel={daily ? "日ごとの売上" : "月ごとの売上"} />
              </div>
            )}
            {showTable && <DayTable rows={mainRows} series={shownDay} />}
          </section>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <h2 className="font-bold">分類ごとの売上（{periodLabel}）</h2>
              <div className="mt-3">
                {catTotals.length === 0 ? (
                  <p className="text-sm text-gray-400">売上はまだありません</p>
                ) : (
                  <HBars
                    items={catTotals.map((c) => ({
                      ...c,
                      note: monthTotal > 0 ? `${Math.round((c.value / monthTotal) * 100)}%` : undefined,
                    }))}
                  />
                )}
              </div>
            </section>
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <h2 className="font-bold">月ごとの売上（直近6か月）</h2>
              {hidden.length > 0 && <p className="text-xs text-gray-500">上で選んだ分類だけを表示しています</p>}
              <div className="mt-2">
                <StackedColumns
                  rows={monthRows}
                  series={shownMonthly}
                  height={200}
                  width={360}
                  ariaLabel="月ごとの売上"
                />
              </div>
              {showTable && (
                <table className="mt-3 w-full text-sm">
                  <tbody>
                    {monthRows.map((m) => (
                      <tr key={m.key} className="border-t">
                        <td className="py-1">{m.sub}</td>
                        <td className="py-1 text-right tabular-nums">{yen(shownSum(m.values, shownMonthly))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub, href }: { label: string; value: string; sub?: string; href: string }) {
  return (
    <Link href={href} className="block rounded-2xl bg-white p-4 shadow-sm active:bg-gray-50">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-sm text-gray-600">{sub}</div>}
    </Link>
  );
}

function DayTable({ rows, series }: { rows: { key: string; sub?: string; values: Record<string, number> }[]; series: Series[] }) {
  const withSales = rows.filter((r) => series.some((x) => (r.values[x.key] ?? 0) > 0));
  if (withSales.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="py-1 pr-3">日付</th>
            {series.map((s) => (
              <th key={s.key} className="py-1 pr-3 text-right">
                {s.label}
              </th>
            ))}
            <th className="py-1 text-right">合計</th>
          </tr>
        </thead>
        <tbody>
          {withSales.map((r) => (
            <tr key={r.key} className="border-t">
              <td className="py-1 pr-3">{r.sub}</td>
              {series.map((s) => (
                <td key={s.key} className="py-1 pr-3 text-right tabular-nums">
                  {(r.values[s.key] ?? 0).toLocaleString("ja-JP")}
                </td>
              ))}
              <td className="py-1 text-right font-semibold tabular-nums">
                {series.reduce((n, x) => n + (r.values[x.key] ?? 0), 0).toLocaleString("ja-JP")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
