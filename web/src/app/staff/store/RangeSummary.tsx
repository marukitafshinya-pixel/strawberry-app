"use client";

// 店舗実績を、選んだ期間（〇月〇日〜〇月〇日）で合計する。去年の同じ期間とも比べられる
import { useState } from "react";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import { STORE_ITEMS, STORE_KEYS, useStoreDaysWithRegi, type StoreDay, type StoreKey } from "@/lib/store";

const withYear = (ymd: string, year: number) => `${year}-${ymd.slice(5) === "02-29" ? "02-28" : ymd.slice(5)}`;

/** 期間の合計と、数字が入っている日（営業日）の数 */
function sumRange(days: Record<string, StoreDay> | null, from: string, to: string) {
  const v = Object.fromEntries(STORE_KEYS.map((k) => [k, 0])) as Record<StoreKey, number>;
  let open = 0;
  if (!days) return { v, open, ready: false };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = days[d];
    if (!day) continue;
    let any = false;
    for (const k of STORE_KEYS)
      if (day[k]) {
        v[k] += day[k]!;
        any = true;
      }
    if (any) open++;
  }
  return { v, open, ready: true };
}

export function RangeSummary() {
  const today = todayJST();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [compare, setCompare] = useState(true);
  const valid = !!from && !!to && from <= to;
  const ly = { from: withYear(from, Number(from.slice(0, 4)) - 1), to: withYear(to, Number(to.slice(0, 4)) - 1) };
  const { days } = useStoreDaysWithRegi(valid ? from : today, valid ? to : today);
  const { days: lyDays } = useStoreDaysWithRegi(valid && compare ? ly.from : "9999-01-01", valid && compare ? ly.to : "9999-01-01");
  const now = sumRange(days, from, to);
  const last = sumRange(lyDays, ly.from, ly.to);

  // 表の行：店舗実績の項目に、客単価と営業日数を足す
  const per = (s: { v: Record<StoreKey, number> }) => (s.v.totalCustomers ? Math.round(s.v.total / s.v.totalCustomers) : 0);
  const rows: { label: string; unit: string; now: number; last: number; strong?: boolean }[] = [
    ...STORE_ITEMS.map((it) => ({ label: it.label, unit: it.unit, now: now.v[it.key], last: last.v[it.key], strong: it.key === "total" })),
    { label: "客単価（売上合計÷客数）", unit: "円", now: per(now), last: per(last) },
    { label: "営業日数（数字の入っている日）", unit: "日", now: now.open, last: last.open },
  ];
  const fmt = (n: number, unit: string) => `${n.toLocaleString("ja-JP")}${unit}`;
  const ratio = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const showLy = compare;

  function exportCsv() {
    downloadCsv(`store_${from}_${to}.csv`, [
      ["項目", `${from}〜${to}`, ...(showLy ? [`${ly.from}〜${ly.to}（去年）`, "差", "前年比"] : [])],
      ...rows.map((r) => [r.label, r.now, ...(showLy ? [r.last, r.now - r.last, ratio(r.now, r.last)] : [])]),
    ]);
  }

  return (
    <section className="mt-3 rounded-2xl border border-berry/40 bg-white p-4 shadow-sm">
      <h2 className="font-bold">期間を指定して集計</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border px-2 py-2 text-base" />
        〜
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border px-2 py-2 text-base" />
        <label className="ml-2 flex items-center gap-1.5 font-bold">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="h-5 w-5" />
          去年の同じ期間と比較
        </label>
        <button onClick={exportCsv} disabled={!valid || !now.ready} className="ml-auto rounded-lg border bg-white px-3 py-2 disabled:opacity-40">
          CSVで書き出す
        </button>
      </div>
      {!valid ? (
        <p className="mt-3 text-sm text-red-600">期間を正しく選んでください</p>
      ) : !now.ready || (showLy && !last.ready) ? (
        <p className="mt-3 text-sm text-gray-500">読み込み中…</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-max text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">項目</th>
                <th className="px-3 py-2 text-right">
                  {formatJa(from)}〜{formatJa(to)}
                </th>
                {showLy && (
                  <>
                    <th className="px-3 py-2 text-right">
                      去年（{formatJa(ly.from, true)}〜{formatJa(ly.to)}）
                    </th>
                    <th className="px-3 py-2 text-right">差</th>
                    <th className="px-3 py-2 text-right">前年比</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className={`border-t ${r.strong ? "bg-berry/5 font-bold" : ""}`}>
                  <td className="px-3 py-1.5">{r.label}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(r.now, r.unit)}</td>
                  {showLy && (
                    <>
                      <td className="px-3 py-1.5 text-right">{fmt(r.last, r.unit)}</td>
                      <td className={`px-3 py-1.5 text-right ${r.now - r.last < 0 ? "text-red-600" : ""}`}>
                        {r.now - r.last > 0 ? "+" : ""}
                        {fmt(r.now - r.last, r.unit)}
                      </td>
                      <td className="px-3 py-1.5 text-right">{ratio(r.now, r.last)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">店舗実績の画面と同じ数字（入力・取り込みした日ごとの実績と、アプリのレジの会計）を、選んだ期間で足しています。</p>
    </section>
  );
}
