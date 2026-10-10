// 天気予報：気象庁の予報（上川地方）を読み込んで、forecast/biei に保存する。作業配置表の下に、今日と明日を時間帯ごとに出す。
// - 3時間ごとの天気・気温・風：気象庁「地域時系列予報」（上川地方・気温は旭川）
// - 6時間ごとの降水確率と、1日ごとの天気の文：気象庁「府県天気予報」（上川・留萌地方）
// 気象庁の公開データ（出典を表示して使う）。読み込みは1時間に1回まで（それより新しければ保存してある分を使う）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "./common.js";

/** 上川・留萌地方（府県予報区）と、その中の上川地方（一次細分区域）、気温の地点（旭川） */
export const FORECAST_AREA = { office: "012000", class10: "012010", class10Name: "上川地方", tempPoint: "旭川" };
const MAX_AGE_MS = 60 * 60_000;

/** 時間帯ごとの予報（3時間ごと）。time は ISO（日本時間）。足りない項目は null */
export type ForecastSlot = { time: string; weatherCode: string | null; weather: string | null; temp: number | null; windDir: string | null; windSpeed: number | null };
/** 降水確率（6時間ごと） */
export type ForecastPop = { time: string; pop: number | null };
/** 1日ごとの天気の文（「晴れ 時々 くもり」など）と風の文 */
export type ForecastDay = { date: string; weatherCode: string | null; weather: string | null; wind: string | null };
export type Forecast = { slots: ForecastSlot[]; pops: ForecastPop[]; days: ForecastDay[]; reportDatetime: string | null };

type Json = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const timeOf = (v: unknown): string | null => str(typeof v === "object" ? obj(v).dateTime : v);

/** 府県天気予報（012000.json）から、1日ごとの天気・風と、6時間ごとの降水確率を読む */
export function parseOfficeForecast(json: unknown): { days: ForecastDay[]; pops: ForecastPop[]; reportDatetime: string | null } {
  const short = obj(arr(json)[0]);
  const series = arr(short.timeSeries).map(obj);
  const pickArea = (s: Json) => arr(s.areas).map(obj).find((a) => str(obj(a.area).code) === FORECAST_AREA.class10) ?? obj(arr(s.areas)[0]);
  const days: ForecastDay[] = [];
  const pops: ForecastPop[] = [];
  for (const s of series) {
    const times = arr(s.timeDefines).map(timeOf);
    const a = pickArea(s);
    if (Array.isArray(a.weathers) || Array.isArray(a.weatherCodes)) {
      times.forEach((t, i) => {
        if (t) days.push({ date: t.slice(0, 10), weatherCode: str(arr(a.weatherCodes)[i]), weather: str(arr(a.weathers)[i])?.replace(/\s+/g, " ") ?? null, wind: str(arr(a.winds)[i])?.replace(/\s+/g, " ") ?? null });
      });
    } else if (Array.isArray(a.pops)) {
      times.forEach((t, i) => t && pops.push({ time: t, pop: num(arr(a.pops)[i]) }));
    }
  }
  return { days, pops, reportDatetime: str(short.reportDatetime) };
}

/**
 * 地域時系列予報（VPFD）から、3時間ごとの天気・風（地域）と気温（地点）を読む。
 * 形が少し違っても読めるよう、名前の候補をいくつか見る。読めなければ空を返す
 */
export function parseTimeSeriesForecast(json: unknown): ForecastSlot[] {
  const root = obj(Array.isArray(json) ? arr(json)[0] : json);
  const area = obj(root.areaTimeSeries);
  const point = obj(root.pointTimeSeries);
  const times = arr(area.timeDefines).map(timeOf);
  if (times.length === 0) return [];
  const weathers = arr(area.weather);
  const codes = arr(area.weatherCode ?? area.weatherCodes);
  const winds = arr(area.wind).map(obj);
  const pTimes = arr(point.timeDefines).map(timeOf);
  const temps = arr(point.temperature ?? point.temperatures);
  const tempAt = new Map(pTimes.map((t, i) => [t, num(temps[i])]));
  return times
    .map((t, i): ForecastSlot | null => {
      if (!t) return null;
      const w = winds[i] ?? {};
      return {
        time: t,
        weatherCode: str(codes[i]),
        weather: str(weathers[i]),
        temp: tempAt.get(t) ?? null,
        windDir: str(w.direction),
        windSpeed: num(w.speed),
      };
    })
    .filter((x): x is ForecastSlot => x !== null);
}

const UA = { "User-Agent": "ichigo-app (forecast; hourly at most)" };
async function fetchJson(url: string, fixture: string): Promise<unknown> {
  // テスト環境（エミュレーター）では、気象庁には取りに行かず、用意したデータを使う
  if (process.env.FUNCTIONS_EMULATOR === "true") return JSON.parse(readFileSync(join(__dirname, `../test-fixtures/${fixture}`), "utf8"));
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`気象庁の予報を読めませんでした（${res.status}）`);
  return res.json();
}

/** 天気予報を新しくする（1時間以内に読み込んであれば、なにもしない）。スタッフ・従業員 */
export const refreshForecast = onCall({ timeoutSeconds: 60 }, async (req) => {
  const role = req.auth?.token.role;
  if (!req.auth || !["admin", "staff", "worker"].includes(String(role))) throw new HttpsError("permission-denied", "ログインしてください");
  const ref = db.doc("forecast/biei");
  const cur = await ref.get();
  const at = cur.get("fetchedAt") as Timestamp | undefined;
  if (at && Date.now() - at.toMillis() < MAX_AGE_MS && req.data?.force !== true) return { ok: true, cached: true };

  const office = parseOfficeForecast(await fetchJson(`https://www.jma.go.jp/bosai/forecast/data/forecast/${FORECAST_AREA.office}.json`, "jma-forecast-office.json"));
  // 3時間ごとの予報は、読めなくても1日ごとの予報だけで出す
  let slots: ForecastSlot[] = [];
  let slotsError: string | null = null;
  try {
    slots = parseTimeSeriesForecast(await fetchJson(`https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD/${FORECAST_AREA.class10}.json`, "jma-forecast-vpfd.json"));
    if (slots.length === 0) slotsError = "3時間ごとの予報が読めませんでした";
  } catch (e) {
    slotsError = e instanceof Error ? e.message : "3時間ごとの予報が読めませんでした";
  }
  if (office.days.length === 0 && slots.length === 0) throw new HttpsError("unavailable", "気象庁の予報を読めませんでした。少し時間をおいてやり直してください");
  await ref.set({
    area: FORECAST_AREA.class10Name,
    tempPoint: FORECAST_AREA.tempPoint,
    slots,
    pops: office.pops,
    days: office.days,
    reportDatetime: office.reportDatetime,
    slotsError,
    fetchedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, cached: false, slots: slots.length };
});
