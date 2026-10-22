// 去年の出荷実績（日ごとの合計重量 kg）と美瑛の天気から、「天気でどれだけ変わるか」を出す（stats/pastYield）。
// ・植える時期や株休め（ハウスごとにずらして行う）は毎年ちがうので、去年の「この時期にこれくらい」は使わない。
//   その日の量が、前後7日の平均より何割多いか少ないか（比）を、夜温と前の日の日照で説明する
// ・出荷は1日おきなどなので、前の出荷の次の日〜出荷の日（3日まで）に分けて、1日あたりの量にする
// ・夜温は、その日の最低気温（去年の分は10分ごとの値を集めていないため）。夜温があればそちらを使う
// 実績の数字は経営の情報なので、管理者だけが入れる・読める（pastShipments/{季節}）。計算した係数だけを stats/pastYield に置く
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertAdmin, db } from "./common.js";
import { importMonth, type WeatherDay } from "./weather.js";

export type PastWeather = Record<string, { tMin?: number | null; nightMin?: number | null; sun?: number | null }>;
export type PastModel = {
  /** 使った出荷の回数 */
  n: number;
  /** 夜温が1℃高いと、ふだんの何倍ぶん増えるか（0.02＝2%） */
  b: number;
  /** 前の日の日照が1時間多いと、ふだんの何倍ぶん増えるか */
  c: number;
  meanNight: number;
  meanSun: number;
  /** 夜温・日照のばらつき（今年の記録とまぜるときの重みに使う） */
  varNight: number;
  varSun: number;
};

const DAY = 86400_000;
const shift = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const gap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** 前後この日数の出荷を「ふだん」とする */
const AROUND = 7;
/** 式を作るのに要る出荷の回数 */
const MIN_N = 10;
/** 1日あたりのふだんの量がこれより少ないとき（出はじめ・終わりぎわ）は使わない（kg） */
const MIN_BASE = 5;

/** 去年の出荷実績と天気から、天気の影響の式を出す。足りなければ null */
export function pastModelFrom(ship: Record<string, number>, weather: PastWeather): PastModel | null {
  const dates = Object.keys(ship)
    .filter((d) => ship[d] > 0)
    .sort();
  // 出荷ごとに、収穫した日（前の出荷の次の日〜出荷の日。3日まで）と1日あたりの量
  const blocks = dates.map((d, i) => {
    const k = i === 0 ? 1 : Math.min(3, Math.max(1, gap(dates[i - 1], d)));
    const days = Array.from({ length: k }, (_, j) => shift(d, j - k + 1));
    return { date: d, k, kg: ship[d], days };
  });
  const rows: { y: number; night: number; sun: number }[] = [];
  for (const b of blocks) {
    const nights = b.days.map((d) => weather[d]?.nightMin ?? weather[d]?.tMin);
    const suns = b.days.map((d) => weather[shift(d, -1)]?.sun);
    if (nights.some((x) => x == null) || suns.some((x) => x == null)) continue;
    const around = blocks.filter((o) => o !== b && Math.abs(gap(o.date, b.date)) <= AROUND);
    if (around.length < 3) continue;
    const base = around.reduce((s, o) => s + o.kg, 0) / around.reduce((s, o) => s + o.k, 0);
    if (base < MIN_BASE) continue;
    const y = b.kg / b.k / base;
    if (y < 0.2 || y > 3) continue; // 出荷の都合など、天気では説明できない日
    const avg = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, x) => s + x!, 0) / xs.length;
    rows.push({ y, night: avg(nights), sun: avg(suns) });
  }
  if (rows.length < MIN_N) return null;
  const n = rows.length;
  const mean = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  const mn = mean((r) => r.night);
  const ms = mean((r) => r.sun);
  const my = mean((r) => r.y);
  let sxx = 0;
  let sss = 0;
  let sxs = 0;
  let sxy = 0;
  let ssy = 0;
  for (const r of rows) {
    const dn = r.night - mn;
    const ds = r.sun - ms;
    sxx += dn * dn;
    sss += ds * ds;
    sxs += dn * ds;
    sxy += dn * (r.y - my);
    ssy += ds * (r.y - my);
  }
  // ほとんど同じ値ばかりでも解けるよう、ごく小さい値を足す
  const p = sxx + 0.01 * n;
  const q = sss + 0.01 * n;
  const det = p * q - sxs * sxs;
  if (Math.abs(det) < 1e-9) return null;
  const clamp = (v: number) => Math.min(0.1, Math.max(-0.1, v));
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    n,
    b: r4(clamp((q * sxy - sxs * ssy) / det)),
    c: r4(clamp((p * ssy - sxs * sxy) / det)),
    meanNight: r4(mn),
    meanSun: r4(ms),
    varNight: r4(sxx / n),
    varSun: r4(sss / n),
  };
}

/** 貼り付けた実績の、日付 → kg を確かめる */
function readDays(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") throw new HttpsError("invalid-argument", "実績が入っていません");
  const out: Record<string, number> = {};
  for (const [d, kg] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || typeof kg !== "number" || !Number.isFinite(kg) || kg < 0 || kg > 100000) {
      throw new HttpsError("invalid-argument", `実績の値が正しくありません（${d}）`);
    }
    out[d] = Math.round(kg * 1000) / 1000;
  }
  if (Object.keys(out).length > 400) throw new HttpsError("invalid-argument", "1年分（400日）までにしてください");
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 去年の出荷実績を保存して、天気の影響を計算し直す（管理者）。days を省くと、保存してある実績で計算し直す。
 * 美瑛の天気（日ごとの値）がまだない月は、気象庁から取り込む（1回に4か月まで。残りは次に押したときに続ける）
 */
export const savePastShipments = onCall({ timeoutSeconds: 120 }, async (req) => {
  await assertAdmin(req);
  const season = String(req.data?.season ?? "");
  if (!/^[A-Za-z0-9]{1,10}$/.test(season)) throw new HttpsError("invalid-argument", "季節の名前（例：R7）が正しくありません");
  const ref = db.doc(`pastShipments/${season}`);
  let days: Record<string, number>;
  if (req.data?.days !== undefined) {
    days = readDays(req.data.days);
    await ref.set({ days, updatedAt: FieldValue.serverTimestamp() });
  } else {
    days = ((await ref.get()).get("days") as Record<string, number> | undefined) ?? {};
  }
  const dates = Object.keys(days).sort();
  if (!dates.length) throw new HttpsError("failed-precondition", "実績が保存されていません");

  // 天気（前の日の日照も使うので、最初の日の前の日から）
  const months = new Set<string>();
  for (let d = shift(dates[0], -3); d <= dates[dates.length - 1]; d = shift(d, 1)) months.add(d.slice(0, 7));
  const weather: PastWeather = {};
  const missing: string[] = [];
  let imported = 0;
  for (const ym of [...months].sort()) {
    let snap = await db.doc(`weather/${ym}`).get();
    if (!snap.exists && imported < 4) {
      if (imported > 0) await sleep(500);
      imported++;
      try {
        await importMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
        snap = await db.doc(`weather/${ym}`).get();
      } catch {
        // 読めなければ、足りない月として知らせる
      }
    }
    if (!snap.exists) missing.push(ym);
    const md = (snap.get("days") as Record<string, WeatherDay> | undefined) ?? {};
    for (const [dd, w] of Object.entries(md)) weather[`${ym}-${dd}`] = w;
  }
  const model = pastModelFrom(days, weather);
  const total = Math.round(Object.values(days).reduce((s, x) => s + x, 0));
  await db.doc("stats/pastYield").set({
    season,
    model,
    from: dates[0],
    to: dates[dates.length - 1],
    shipments: dates.filter((d) => days[d] > 0).length,
    total,
    missing,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { model, missing, shipments: dates.filter((d) => days[d] > 0).length, total };
});
