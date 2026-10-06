"use client";

// 日ごとのグラフの表示する範囲（年間・月間・週ごと）を選ぶ
import { useState } from "react";
import { todayJST, weeksOf } from "@/lib/date";

export type DayRange = { kind: "year" } | { kind: "month"; month: number } | { kind: "week"; no: number };

/** 日付がその範囲に入るか（年間ならいつも入る） */
export function inDayRange(date: string, range: DayRange, year: number): boolean {
  if (range.kind === "year") return true;
  if (range.kind === "month") return Number(date.slice(5, 7)) === range.month;
  const w = weeksOf(year).find((x) => x.no === range.no);
  return !!w && date >= w.from && date <= w.to;
}

/** 範囲の状態。月間・週ごとにしたときは、hint の日付（記録がある最後の日。なければ今日）の月・週から始める */
export function useDayRange(year: number, hint?: string) {
  const [range, setRange] = useState<DayRange>({ kind: "year" });
  const t = todayJST();
  const base = hint ?? (t.startsWith(`${year}-`) ? t : `${year}-06-15`);
  const weekOf = (d: string) => weeksOf(year).find((w) => d >= w.from && d <= w.to)?.no ?? 1;
  return {
    range,
    setRange,
    toMonth: () => setRange({ kind: "month", month: Number(base.slice(5, 7)) }),
    toWeek: () => setRange({ kind: "week", no: weekOf(base) }),
  };
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export function DayRangePicker({ year, state }: { year: number; state: ReturnType<typeof useDayRange> }) {
  const { range, setRange, toMonth, toWeek } = state;
  const weeks = weeksOf(year);
  const btn = (on: boolean) => `px-3 py-1.5 ${on ? "bg-sky-700 font-bold text-white" : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm print:hidden">
      <div className="inline-flex overflow-hidden rounded-lg border bg-white">
        <button onClick={() => setRange({ kind: "year" })} className={btn(range.kind === "year")}>
          年間
        </button>
        <button onClick={toMonth} className={btn(range.kind === "month")}>
          月間
        </button>
        <button onClick={toWeek} className={btn(range.kind === "week")}>
          週ごと
        </button>
      </div>
      {range.kind === "month" && (
        <span className="inline-flex items-center gap-1">
          <button onClick={() => setRange({ kind: "month", month: Math.max(1, range.month - 1) })} disabled={range.month <= 1} className="rounded border bg-white px-2 py-1 disabled:opacity-40" aria-label="前の月">
            ‹
          </button>
          <select value={range.month} onChange={(e) => setRange({ kind: "month", month: Number(e.target.value) })} className="rounded border bg-white px-2 py-1" aria-label="月">
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}月
              </option>
            ))}
          </select>
          <button onClick={() => setRange({ kind: "month", month: Math.min(12, range.month + 1) })} disabled={range.month >= 12} className="rounded border bg-white px-2 py-1 disabled:opacity-40" aria-label="次の月">
            ›
          </button>
        </span>
      )}
      {range.kind === "week" && (
        <span className="inline-flex items-center gap-1">
          <button onClick={() => setRange({ kind: "week", no: Math.max(1, range.no - 1) })} disabled={range.no <= 1} className="rounded border bg-white px-2 py-1 disabled:opacity-40" aria-label="前の週">
            ‹
          </button>
          <select value={range.no} onChange={(e) => setRange({ kind: "week", no: Number(e.target.value) })} className="rounded border bg-white px-2 py-1" aria-label="週">
            {weeks.map((w) => (
              <option key={w.no} value={w.no}>
                第{w.no}週（{md(w.from)}〜{md(w.to)}）
              </option>
            ))}
          </select>
          <button onClick={() => setRange({ kind: "week", no: Math.min(weeks.length, range.no + 1) })} disabled={range.no >= weeks.length} className="rounded border bg-white px-2 py-1 disabled:opacity-40" aria-label="次の週">
            ›
          </button>
        </span>
      )}
    </div>
  );
}
