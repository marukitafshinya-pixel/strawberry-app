"use client";

// トータル実績：出荷・店舗の実績に、ほかの売上（玉ねぎ・そば・作業委託＆冷蔵庫リース）を足して月ごとに集計する。
// ほかの売上は、月ごとの合計を手で入れる（otherSales/{年}）。
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export const OTHER_ITEMS = [
  { key: "onion", label: "玉ねぎ" },
  { key: "soba", label: "そば" },
  { key: "contract", label: "作業委託＆冷蔵庫リース" },
] as const;
export type OtherKey = (typeof OTHER_ITEMS)[number]["key"];
/** 月（"01"〜"12"）→ 項目 → 金額 */
export type OtherMonths = Record<string, Partial<Record<OtherKey, number>>>;

/**
 * 出荷・店舗の予測（当月と、それより先の月だけ）。月 → 項目 → 金額。
 * 予測を入れた月は、合計に予測を使う。月が過ぎたら予測は使わず、実績を使う（保存のときに消す）
 */
export const FORECAST_ITEMS = ["ship", "direct", "cafe", "ichigo"] as const;
export type ForecastKey = (typeof FORECAST_ITEMS)[number];
export type Forecast = Record<string, Partial<Record<ForecastKey, number>>>;

/** その年の月（"01"〜"12"）が、予測を入れられる月か（当月と、それより先） */
export function canForecast(year: number, month: string, today: string): boolean {
  return `${year}-${month}` >= today.slice(0, 7);
}

export function useOtherSales(year: number) {
  const [state, setState] = useState<{ year: number; months: OtherMonths; forecast: Forecast } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, `otherSales/${year}`),
        (s) => setState({ year, months: (s.get("months") as OtherMonths | undefined) ?? {}, forecast: (s.get("forecast") as Forecast | undefined) ?? {} }),
        () => setState({ year, months: {}, forecast: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [year]);
  return state && state.year === year ? state : null;
}

export async function saveOtherSales(year: number, months: OtherMonths, forecast: Forecast, today: string) {
  const { db } = await getFirebase();
  const clean: OtherMonths = {};
  for (const [m, v] of Object.entries(months)) {
    const row: Partial<Record<OtherKey, number>> = {};
    for (const it of OTHER_ITEMS) {
      const n = v[it.key];
      if (typeof n === "number" && Number.isFinite(n) && n !== 0) row[it.key] = Math.round(n);
    }
    if (Object.keys(row).length) clean[m] = row;
  }
  // 予測は、当月と先の月の分だけ残す（過ぎた月の予測は消して、実績にする）
  const fc: Forecast = {};
  for (const [m, v] of Object.entries(forecast)) {
    if (!canForecast(year, m, today)) continue;
    const row: Partial<Record<ForecastKey, number>> = {};
    for (const k of FORECAST_ITEMS) {
      const n = v[k];
      if (typeof n === "number" && Number.isFinite(n)) row[k] = Math.round(n);
    }
    if (Object.keys(row).length) fc[m] = row;
  }
  await setDoc(doc(db, `otherSales/${year}`), { months: clean, forecast: fc, updatedAt: serverTimestamp() });
}
