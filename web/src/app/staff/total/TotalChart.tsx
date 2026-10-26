"use client";

// いちごトータル実績のグラフ：店舗合計・出荷合計・いちご合計（出荷＋店舗）を、週・月で重ねて見る。
// 6月〜11月だけを出す。実績だけで描く（予測・チケット・規格外・催事は入れない）。
// 前年と比べるときは、前の年の同じ番目の週（6月1日を含む週から数える）・同じ月を点線で重ねる
import { useState } from "react";
import { CompareLines, Legend, SERIES_COLORS, type Series } from "@/components/charts";
import { todayJST } from "@/lib/date";
import { shipAmount, useShipments } from "@/lib/shipping";
import { useStoreDaysWithRegi } from "@/lib/store";

type Shipments = NonNullable<ReturnType<typeof useShipments>>;
type StoreDays = NonNullable<ReturnType<typeof useStoreDaysWithRegi>["days"]>;
type Unit = "week" | "month";

const SERIES: Series[] = [
  { key: "store", label: "店舗合計", color: SERIES_COLORS[0] },
  { key: "ship", label: "出荷合計", color: SERIES_COLORS[1] },
  { key: "ichigo", label: "いちご合計", color: SERIES_COLORS[2], width: 4 },
];
const DAY = 86_400_000;
const yen = (n: number | null) => (n == null ? "－" : n.toLocaleString("ja-JP"));
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
/** グラフに出す月（6月〜11月） */
const FIRST_MONTH = 6;
const LAST_MONTH = 11;
/** 1番目の週のはじめ（6月1日を含む週の月曜） */
const weekBase = (year: number) => {
  const t = Date.UTC(year, FIRST_MONTH - 1, 1);
  return t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
};

/** 日ごとの出荷の金額（数量×単価。単価が入っている分だけ） */
const shipByDay = (s: Shipments) =>
  Object.entries(s).map(
    ([d, items]) => [d, Object.values(items).reduce((a, it) => a + (it.qty && it.price !== undefined ? shipAmount(it.qty, it.price) : 0), 0)] as const,
  );
/** 日ごとの店舗の金額（直売・カフェ・いちご狩り。内訳がない日は売上合計） */
const storeByDay = (s: StoreDays) => Object.entries(s).map(([d, x]) => [d, (x.direct ?? 0) + (x.cafe ?? 0) + (x.ichigo ?? 0) || (x.total ?? 0)] as const);

/** 週・月ごとに足す（6月〜11月の日だけ）。index＝何番目の週（0から）・6月から何か月目（0から） */
function bucket(days: (readonly [string, number])[], year: number, unit: Unit, n: number) {
  const out = Array<number>(n).fill(0);
  for (const [d, v] of days) {
    const m = Number(d.slice(5, 7));
    if (!d.startsWith(`${year}-`) || m < FIRST_MONTH || m > LAST_MONTH) continue;
    const i = unit === "month" ? m - FIRST_MONTH : Math.floor((utc(d) - weekBase(year)) / (7 * DAY));
    if (i >= 0 && i < n) out[i] += v;
  }
  return out;
}

export function TotalChart({
  year,
  shipments,
  store,
  prevShipments,
  prevStore,
}: {
  year: number;
  shipments: Shipments;
  store: StoreDays;
  prevShipments: Shipments;
  prevStore: StoreDays;
}) {
  const [unit, setUnit] = useState<Unit>("month");
  const [compare, setCompare] = useState(false);
  const today = todayJST();
  const n = unit === "month" ? LAST_MONTH - FIRST_MONTH + 1 : Math.floor((Date.UTC(year, LAST_MONTH, 0) - weekBase(year)) / (7 * DAY)) + 1;
  const ship = bucket(shipByDay(shipments), year, unit, n);
  const st = bucket(storeByDay(store), year, unit, n);
  const pShip = bucket(shipByDay(prevShipments), year - 1, unit, n);
  const pSt = bucket(storeByDay(prevStore), year - 1, unit, n);
  /** その週・月のはじめの日（はじめの週は6月1日から） */
  const startOf = (i: number) =>
    unit === "month"
      ? `${year}-${String(i + FIRST_MONTH).padStart(2, "0")}-01`
      : ymd(Math.max(weekBase(year) + i * 7 * DAY, Date.UTC(year, FIRST_MONTH - 1, 1)));
  const label = (i: number) => {
    const d = startOf(i);
    return unit === "month" ? `${i + FIRST_MONTH}月` : `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}〜`;
  };
  const rows = Array.from({ length: n }, (_, i) => {
    // まだ来ていない週・月は線を切る
    const come = startOf(i) <= today;
    return {
      key: String(i),
      label: label(i),
      values: { store: come ? st[i] : null, ship: come ? ship[i] : null, ichigo: come ? st[i] + ship[i] : null },
      prev: { store: pSt[i], ship: pShip[i], ichigo: pSt[i] + pShip[i] },
    };
  });
  const btn = (on: boolean) => `rounded-lg border px-3 py-1.5 text-sm ${on ? "bg-berry font-bold text-white" : "bg-white"}`;
  const pct = (v: number | null, p: number | null) => (v != null && p ? `${Math.round((v / p) * 100)}%` : "");

  return (
    <section className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold">いちごトータル実績（{year}年）</h2>
        <div className="ml-auto flex gap-1">
          <button onClick={() => setUnit("week")} className={btn(unit === "week")}>
            週
          </button>
          <button onClick={() => setUnit("month")} className={btn(unit === "month")}>
            月
          </button>
        </div>
        <button onClick={() => setCompare(!compare)} className={btn(compare)}>
          {compare ? "✓ " : ""}前年と比べる
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Legend series={SERIES} />
        {compare && (
          <span className="flex items-center gap-1.5 text-xs text-gray-700">
            <svg width="22" height="8" aria-hidden>
              <line x1="1" x2="21" y1="4" y2="4" stroke="#6b6a64" strokeWidth="1.5" strokeDasharray="5 4" />
            </svg>
            点線は{year - 1}年
          </span>
        )}
      </div>
      <div className="mt-2">
        <CompareLines rows={rows} series={SERIES} compare={compare} />
      </div>
      <p className="mt-1 text-xs text-gray-500">
        6月〜11月の実績だけで描いています（予測・チケット・規格外・催事は入れていません）。いちご合計＝出荷合計＋店舗合計。
        {unit === "week" ? "週は月曜はじまり（はじめの週は6月1日から）です。" : ""}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-gray-600">数字の表を見る</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-max text-right text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-2 py-1 text-left">{unit === "week" ? "週" : "月"}</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-2 py-1" colSpan={compare ? 3 : 1}>
                    {s.label}
                    {compare ? `（今年・前年・前年比）` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="px-2 py-1 text-left">{r.label}</td>
                  {SERIES.map((s) => {
                    const v = r.values[s.key as keyof typeof r.values];
                    const p = r.prev[s.key as keyof typeof r.prev];
                    return compare ? (
                      <Cells key={s.key} v={v} p={p} pct={pct(v, p)} />
                    ) : (
                      <td key={s.key} className="px-2 py-1">
                        {yen(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Cells({ v, p, pct }: { v: number | null; p: number | null; pct: string }) {
  return (
    <>
      <td className="px-2 py-1">{yen(v)}</td>
      <td className="px-2 py-1 text-gray-500">{yen(p)}</td>
      <td className="px-2 py-1 text-gray-500">{pct}</td>
    </>
  );
}
