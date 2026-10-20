// 美瑛と旭川の気温の差：天気予報の気温は旭川（上川地方の代表の地点）しかないので、
// アメダス美瑛と旭川の実際の気温（10分ごとの値の3時間ごと）を毎日集め、時刻ごとの差（美瑛−旭川）の最近14日の平均で予報を美瑛の気温に直す。
// 集めた差は stats/tempDiff に残す（サーバーだけが読み書きする）
import { FieldValue } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./common.js";
import { parseJma10min, WEATHER_STATION } from "./weather.js";

/** 旭川（気象台）。10分ごとの値のページの形が、アメダス（美瑛）とちがう（10min_s1） */
const ASAHIKAWA = { name: "旭川", precNo: 12, blockNo: "47407" };
/** 平均に使う日数 */
export const DIFF_DAYS = 14;
/** 補正に使うのに要る日数 */
export const MIN_DIFF_DAYS = 3;
/** 1回に読みに行く日数（1日で2ページ。気象庁のサイトに負担をかけない） */
const MAX_DAYS_PER_RUN = 6;
/** 予報の時刻（3時間ごと） */
export const DIFF_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

const shiftDate = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** その日の、時刻ごとの差（美瑛−旭川、℃）。0時は「24:00」（その日の終わり）の値で数える */
export function diffOfDay(biei: { time: string; temp: number | null }[], asahi: { time: string; temp: number | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of DIFF_HOURS) {
    const t = h === 0 ? "24:00" : `${String(h).padStart(2, "0")}:00`;
    const b = biei.find((x) => x.time === t)?.temp;
    const a = asahi.find((x) => x.time === t)?.temp;
    if (b != null && a != null) out[String(h)] = Math.round((b - a) * 10) / 10;
  }
  return out;
}

/** 日ごとの差から、時刻ごとの平均（最近の日から DIFF_DAYS 日）。日数が足りない時刻は入れない */
export function averageDiff(days: Record<string, Record<string, number>>): { avg: Record<string, number>; n: number } {
  const dates = Object.keys(days).sort().slice(-DIFF_DAYS);
  const avg: Record<string, number> = {};
  for (const h of DIFF_HOURS) {
    const v = dates.map((d) => days[d]?.[String(h)]).filter((x): x is number => typeof x === "number");
    if (v.length >= MIN_DIFF_DAYS) avg[String(h)] = Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10;
  }
  return { avg, n: dates.length };
}

/** 予報の時刻（ISO）の差。3時間ごとの時刻にないときは、いちばん近い時刻の差 */
export function diffAt(avg: Record<string, number>, iso: string): number | null {
  const h = Number(iso.slice(11, 13));
  const near = DIFF_HOURS.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), 0);
  return avg[String(near)] ?? null;
}

const url = (st: { precNo: number; blockNo: string }, kind: "a1" | "s1", date: string) =>
  `https://www.data.jma.go.jp/stats/etrn/view/10min_${kind}.php?prec_no=${st.precNo}&block_no=${st.blockNo}&year=${Number(date.slice(0, 4))}&month=${Number(date.slice(5, 7))}&day=${Number(date.slice(8, 10))}&view=`;

async function page(st: { precNo: number; blockNo: string }, kind: "a1" | "s1", date: string) {
  // テスト環境（エミュレーター）では、気象庁には取りに行かず、用意したページを使う（どちらも美瑛のページ＝差は0）
  if (process.env.FUNCTIONS_EMULATOR === "true") return parseJma10min(readFileSync(join(__dirname, "../test-fixtures/jma-10min-a1.html"), "utf8"));
  const res = await fetch(url(st, kind, date), { headers: { "User-Agent": "ichigo-app (temperature difference; a few pages per day)" } });
  if (!res.ok) throw new Error(`気象庁のページを読めませんでした（${res.status}）`);
  return parseJma10min(await res.text());
}

/** まだ集めていない日（昨日から DIFF_DAYS 日前まで）を、新しい日から少しずつ集める */
export async function updateTempDiff(): Promise<{ added: number; n: number }> {
  const ref = db.doc("stats/tempDiff");
  const days = ((await ref.get()).get("days") as Record<string, Record<string, number>> | undefined) ?? {};
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  let added = 0;
  for (let i = 1; i <= DIFF_DAYS && added < MAX_DAYS_PER_RUN; i++) {
    const d = shiftDate(today, -i);
    if (days[d]) continue;
    try {
      const b = await page(WEATHER_STATION, "a1", d);
      await sleep(500);
      const a = await page(ASAHIKAWA, "s1", d);
      await sleep(500);
      const diff = diffOfDay(b, a);
      if (Object.keys(diff).length) {
        days[d] = diff;
        added++;
      }
    } catch {
      break; // 読めなければ、次の回にやり直す
    }
  }
  // 古い日は消す
  for (const d of Object.keys(days)) if (d < shiftDate(today, -(DIFF_DAYS + 7))) delete days[d];
  const { avg, n } = averageDiff(days);
  await ref.set({ days, avg, n, updatedAt: FieldValue.serverTimestamp() });
  return { added, n };
}

/** 1時間ごとに、まだ集めていない日があれば集める（そろっていれば気象庁には取りに行かない） */
export const refreshTempDiff = onSchedule({ schedule: "40 * * * *", timeZone: "Asia/Tokyo", timeoutSeconds: 120 }, async () => {
  await updateTempDiff();
});
