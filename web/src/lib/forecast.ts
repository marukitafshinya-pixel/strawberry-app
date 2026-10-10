"use client";

// 天気予報（気象庁・上川地方）。サーバー（refreshForecast）が気象庁から読み込んで forecast/biei に保存したものを見る。
// 画面を開いたときと30分ごとに、古ければ（1時間より前なら）サーバーに読み込み直してもらう。
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";

export type ForecastSlot = { time: string; weatherCode: string | null; weather: string | null; temp: number | null; windDir: string | null; windSpeed: number | null };
export type ForecastPop = { time: string; pop: number | null };
export type ForecastDay = { date: string; weatherCode: string | null; weather: string | null; wind: string | null };
export type Forecast = {
  area: string;
  tempPoint: string;
  slots: ForecastSlot[];
  pops: ForecastPop[];
  days: ForecastDay[];
  reportDatetime: string | null;
  fetchedAt?: { toDate: () => Date };
};

export function useForecast(): { data: Forecast | null; error: string } {
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "forecast/biei"),
        (snap) => setData(snap.exists() ? (snap.data() as Forecast) : null),
        () => {},
      );
    });
    const refresh = () =>
      callFunction("refreshForecast", {})
        .then(() => setError(""))
        .catch(() => setError("天気予報を読み込めませんでした"));
    void refresh();
    const timer = setInterval(refresh, 30 * 60_000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(timer);
    };
  }, []);
  return { data, error };
}

/** 天気の絵（気象庁の天気コードの頭の数字：1 晴れ・2 くもり・3 雨・4 雪） */
export function weatherIcon(code: string | null, text: string | null): string {
  const c = code?.[0] ?? (text?.includes("雪") ? "4" : text?.includes("雨") ? "3" : text?.includes("くもり") || text?.includes("曇") ? "2" : text?.includes("晴") ? "1" : "");
  return c === "1" ? "☀️" : c === "2" ? "☁️" : c === "3" ? "☔" : c === "4" ? "⛄" : "";
}

/**
 * その日の最高気温と最低気温（3時間ごとの予報から）。
 * 最高＝その日の 9:00〜14:00 のいちばん高い気温、最低＝その日の 21:00〜翌日 8:00 のいちばん低い気温。予報がなければ null
 */
export function dayHighLow(f: Forecast, date: string): { high: number | null; low: number | null } {
  const at = (s: ForecastSlot) => Date.parse(s.time);
  const start = (h: number, plusDay = 0) => Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+09:00`) + plusDay * 86400_000;
  const within = (from: number, to: number) => f.slots.filter((s) => s.temp !== null && at(s) >= from && at(s) <= to).map((s) => s.temp as number);
  const hi = within(start(9), start(14));
  const lo = within(start(21), start(8, 1));
  return { high: hi.length ? Math.max(...hi) : null, low: lo.length ? Math.min(...lo) : null };
}
