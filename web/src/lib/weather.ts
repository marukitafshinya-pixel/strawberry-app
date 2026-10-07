"use client";

// 気象データ（気象庁のアメダス「美瑛」の日ごとの値）。取り込みはサーバー側（importWeatherMonth）
import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export const WEATHER_STATION_NAME = "美瑛";
/** 気象庁のページ（その月の日ごとの値） */
export const jmaPageUrl = (year: number, month: number) =>
  `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=12&block_no=1052&year=${year}&month=${month}&day=&view=`;

export type WeatherDay = {
  precip?: number | null;
  tAvg?: number | null;
  tMax?: number | null;
  tMin?: number | null;
  sun?: number | null;
};
export type WeatherKey = keyof WeatherDay;
export type WeatherMonth = { month: string; days: Record<string, WeatherDay>; fetchedAt?: { toDate: () => Date } };

/** 表に出す項目。sum＝月の合計を出す、avg＝月の平均、max/min＝月の最大・最小 */
export const WEATHER_ITEMS: { key: WeatherKey; label: string; unit: string; agg: "sum" | "avg" | "max" | "min" }[] = [
  { key: "tAvg", label: "平均気温", unit: "℃", agg: "avg" },
  { key: "tMax", label: "最高気温", unit: "℃", agg: "max" },
  { key: "tMin", label: "最低気温", unit: "℃", agg: "min" },
  { key: "precip", label: "降水量（合計）", unit: "mm", agg: "sum" },
  { key: "sun", label: "日照時間", unit: "h", agg: "sum" },
];

/** 月（"YYYY-MM"）の範囲の気象データ */
export function useWeatherMonths(from: string, to: string) {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; data: WeatherMonth[] } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        query(collection(db, "weather"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) =>
          setState({
            key,
            data: snap.docs.map((d) => ({ month: d.id, days: (d.get("days") as Record<string, WeatherDay>) ?? {}, fetchedAt: d.get("fetchedAt") })),
          }),
        () => setState({ key, data: [] }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [from, to, key]);
  return state && state.key === key ? state.data : null;
}

/** 日ごとの値をまとめる（合計・平均・最大・最小）。値のない日は数えない */
export function aggregate(values: (number | null | undefined)[], agg: "sum" | "avg" | "max" | "min"): number | null {
  const v = values.filter((x): x is number => typeof x === "number");
  if (v.length === 0) return null;
  if (agg === "sum") return Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10;
  if (agg === "avg") return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
  return agg === "max" ? Math.max(...v) : Math.min(...v);
}

/** 期間（from〜to の日）の気象の値。気温はその期間の平均、降水量・日照時間は合計 */
export function weatherOfSpan(months: WeatherMonth[], from: string, to: string): Partial<Record<WeatherKey, number | null>> {
  const list: WeatherDay[] = [];
  for (const m of months) {
    for (const [d, v] of Object.entries(m.days)) {
      const date = `${m.month}-${d}`;
      if (date >= from && date <= to) list.push(v);
    }
  }
  const pick = (k: WeatherKey, agg: "sum" | "avg") => aggregate(list.map((v) => v[k]), agg);
  return { tAvg: pick("tAvg", "avg"), tMax: pick("tMax", "avg"), tMin: pick("tMin", "avg"), precip: pick("precip", "sum"), sun: pick("sun", "sum") };
}

const SHOW_KEY = "ichigo.weatherShow";
const ALL_KEYS: WeatherKey[] = ["tAvg", "tMax", "tMin", "precip", "sun"];

/** グラフに並べる気象の項目（チェックボックス）。この端末に覚えておく */
export function useWeatherShow() {
  const [show, setShow] = useState<WeatherKey[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SHOW_KEY) ?? "null");
      if (Array.isArray(v)) return ALL_KEYS.filter((k) => v.includes(k));
    } catch {}
    return [];
  });
  const change = (v: WeatherKey[]) => {
    setShow(v);
    try {
      localStorage.setItem(SHOW_KEY, JSON.stringify(v));
    } catch {}
  };
  return [show, change] as const;
}
