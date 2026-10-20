"use client";

// 天気予報（気象庁・上川地方）。サーバー（refreshForecast）が気象庁から読み込んで forecast/biei に保存したものを見る。
// 画面を開いたときと30分ごとに、古ければ（1時間より前なら）サーバーに読み込み直してもらう。
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";

export type ForecastSlot = {
  time: string;
  weatherCode: string | null;
  weather: string | null;
  temp: number | null;
  windDir: string | null;
  windSpeed: number | null;
};
export type ForecastPop = { time: string; pop: number | null };
export type ForecastDay = { date: string; weatherCode: string | null; weather: string | null; wind: string | null };
/** 1日ごとの見込み（週間予報など）：天気・降水確率（1日）・最低・最高 */
export type WeeklyDay = { date: string; weatherCode: string | null; pop: number | null; tempMin: number | null; tempMax: number | null };
export type Forecast = {
  area: string;
  tempPoint: string;
  slots: ForecastSlot[];
  pops: ForecastPop[];
  days: ForecastDay[];
  weekly?: WeeklyDay[];
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
  const c =
    code?.[0] ??
    (text?.includes("雪") ? "4" : text?.includes("雨") ? "3" : text?.includes("くもり") || text?.includes("曇") ? "2" : text?.includes("晴") ? "1" : "");
  return c === "1" ? "☀️" : c === "2" ? "☁️" : c === "3" ? "☔" : c === "4" ? "⛄" : "";
}

/**
 * その日の最高気温と最低気温（3時間ごとの予報から）。
 * 最高＝その日（0:00〜24:00）のいちばん高い気温、最低＝その日の 0:00〜翌日 8:00 のいちばん低い気温。
 * 3時間ごとの予報がまだなければ週間予報の最高・最低、それもなければ null
 */
export function dayHighLow(f: Forecast, date: string): { high: number | null; low: number | null } {
  const at = (s: ForecastSlot) => Date.parse(s.time);
  const start = (h: number, plusDay = 0) => Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+09:00`) + plusDay * 86400_000;
  const within = (from: number, to: number) => f.slots.filter((s) => s.temp !== null && at(s) >= from && at(s) <= to).map((s) => s.temp as number);
  const hi = within(start(0), start(0, 1) - 1);
  const lo = within(start(0), start(8, 1));
  // 3時間ごとの予報がその時間までまだ出ていなければ（昼すぎ・翌朝）、週間予報の最高・最低を使う
  const w = f.weekly?.find((x) => x.date === date);
  const covers = (t: number) => f.slots.some((s) => at(s) >= t);
  const high = covers(start(15)) || w?.tempMax == null ? (hi.length ? Math.max(...hi) : null) : w.tempMax;
  const low = covers(start(6, 1)) || w?.tempMin == null ? (lo.length ? Math.min(...lo) : null) : w.tempMin;
  return { high, low };
}
