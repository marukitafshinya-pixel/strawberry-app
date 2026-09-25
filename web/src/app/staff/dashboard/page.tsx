"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { HBars, Legend, Meter, NEUTRAL, SERIES_COLORS, StackedColumns, type Series } from "@/components/charts";
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
import { useImportedSales, useReceivables, useSales, type Sale } from "@/lib/sales";
import { DEFAULT_PLAN_CATEGORY, type Settings } from "@/lib/settings";

const IMPORTED = "__imported";
const OTHER = "その他";

/** "YYYY-MM" を n か月ずらす */
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const lastDay = (ym: string) => addDays(`${shiftMonth(ym, 1)}-01`, -1);

/**
 * 分類ごとの色を決める。月を切り替えても同じ分類は同じ色になるよう、
 * 設定画面の並び（プラン → 商品）で順番を固定する。8つ目以降は「その他」にまとめる。
 */
function categoryOrder(settings: Settings, seen: string[]): string[] {
  const fromSettings = [
    ...settings.plans.map((p) => p.category ?? DEFAULT_PLAN_CATEGORY),
    ...settings.products.map((p) => p.group || OTHER),
  ];
  const all = [...new Set([...fromSettings, ...seen.sort()])].filter((c) => c !== OTHER);
  return [...all.slice(0, SERIES_COLORS.length - 1), OTHER];
}

export default function DashboardPage() {
  const today = todayJST();
  const [month, setMonth] = useState(today.slice(0, 7));
  const from = `${shiftMonth(month, -5)}-01`;
  const to = lastDay(month);

  const { value: settings } = useSettings();
  const { value: sales } = useSales(from, to);
  const { value: imported } = useImportedSales(from, to);
  const { value: openReceivables } = useReceivables("open");
  const { value: todayReservations } = useReservations(today);
  const { value: todayCapacity } = useDailyCapacity(today);
  const { value: requests } = usePendingRequests(today);
  const [showTable, setShowTable] = useState(false);

  const data = useMemo(() => {
    if (!settings || !sales || !imported) return null;
    // 日付 → 分類 → 金額（アプリで会計した日はアプリの合計、ない日は取り込んだ合計）
    const byDay = new Map<string, Record<string, number>>();
    const done: Sale[] = sales.filter((s) => s.status === "completed");
    const seen = [...new Set(done.flatMap((s) => s.lines.map((l) => l.category)))];
    const order = categoryOrder(settings, seen);
    const fold = (c: string) => (order.includes(c) ? c : OTHER);
    for (const s of done) {
      const m = byDay.get(s.date) ?? {};
      for (const l of s.lines) m[fold(l.category)] = (m[fold(l.category)] ?? 0) + l.amount;
      byDay.set(s.date, m);
    }
    for (const im of imported) {
      if (!byDay.has(im.id)) byDay.set(im.id, { [IMPORTED]: im.amount });
    }
    const usedKeys = new Set([...byDay.values()].flatMap((m) => Object.keys(m)));
    const series: Series[] = [
      ...order.map((c, i) => ({ key: c, label: c, color: SERIES_COLORS[i] })).filter((s) => usedKeys.has(s.key)),
      ...(usedKeys.has(IMPORTED) ? [{ key: IMPORTED, label: "取り込み（内訳なし）", color: NEUTRAL }] : []),
    ];
    return { byDay, series };
  }, [settings, sales, imported]);

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  // 選んだ月の日ごと
  const days: string[] = [];
  for (let d = `${month}-01`; d <= to; d = addDays(d, 1)) days.push(d);
  const dayRows = days.map((d) => ({
    key: d,
    label: String(Number(d.slice(8))),
    sub: `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${weekday(d)}）`,
    values: data?.byDay.get(d) ?? {},
  }));
  const sum = (v: Record<string, number>) => Object.values(v).reduce((n, x) => n + x, 0);
  const monthTotal = dayRows.reduce((n, r) => n + sum(r.values), 0);
  // 凡例はこの月に出てくる分類だけ（色は月をまたいでも同じ）
  const monthSeries = (data?.series ?? []).filter((s) => dayRows.some((r) => (r.values[s.key] ?? 0) > 0));

  // 分類ごと（選んだ月）
  const catTotals = (data?.series ?? [])
    .map((s) => ({ key: s.key, label: s.label, color: s.color, value: dayRows.reduce((n, r) => n + (r.values[s.key] ?? 0), 0) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);

  // 月ごと（直近6か月）
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const monthRows = months.map((m) => {
    let total = 0;
    for (const [d, v] of data?.byDay ?? []) if (d.startsWith(m)) total += sum(v);
    return { key: m, label: `${Number(m.slice(5))}月`, sub: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, values: { total } };
  });

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
        <Tile label={`${Number(month.slice(5))}月の売上`} value={yen(monthTotal)} href={`/staff/sales/?date=${today}`} />
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

      {/* 月の切り替え（グラフの上に1列で） */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-28 text-center font-bold">
          {month.slice(0, 4)}年{Number(month.slice(5))}月
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
        {month !== today.slice(0, 7) && (
          <button onClick={() => setMonth(today.slice(0, 7))} className="rounded-lg border bg-white px-3 py-2">
            今月
          </button>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm">
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
              <h2 className="font-bold">日ごとの売上</h2>
              <span className="text-sm text-gray-600">合計 {yen(monthTotal)}</span>
            </div>
            <div className="mt-2">
              <Legend series={monthSeries} />
            </div>
            {monthTotal === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">この月の売上はまだありません</p>
            ) : (
              <div className="mt-2">
                <StackedColumns rows={dayRows} series={monthSeries} ariaLabel={`${month}の日ごとの売上`} />
              </div>
            )}
            {showTable && <DayTable rows={dayRows} series={monthSeries} />}
          </section>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <h2 className="font-bold">分類ごとの売上（{Number(month.slice(5))}月）</h2>
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
              <div className="mt-2">
                <StackedColumns
                  rows={monthRows}
                  series={[{ key: "total", label: "売上", color: SERIES_COLORS[0] }]}
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
                        <td className="py-1 text-right tabular-nums">{yen(m.values.total)}</td>
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
  const withSales = rows.filter((r) => Object.values(r.values).some((v) => v > 0));
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
                {Object.values(r.values)
                  .reduce((n, v) => n + v, 0)
                  .toLocaleString("ja-JP")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
