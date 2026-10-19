// 収穫管理：人ごとの収穫の速さ（1,000株あたりの分）を、最近の記録から計算して stats/harvestSpeed に保存する。
// スタッフや集荷係は過去の記録を読めないので、予測に使う速さだけをサーバーで計算して渡す。
// 使う記録：1人だけで収穫したハウスで、入った・終わった時刻があるもの（株数はハウスの大きさ。いちご狩り前・後ろは半分）
// その日の集荷係（作業配置表の「集荷係」の枠）が収穫にも入ったハウスは、集荷をしながらなので速さには入れない
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "./common.js";

/** 人ごとに使う最近の記録の数 */
const PER_PERSON = 20;
/** 全員の平均に使う最近の記録の数 */
const ALL = 60;
/** さかのぼる日数 */
const DAYS = 45;

/** 画面側（web/src/lib/harvest.ts）と同じ、はじめの株数 */
const DEFAULT_PLANTS: Record<string, number> = {
  "21": 3448,
  "22": 3424,
  "23": 3424,
  "24": 3424,
  "25": 3424,
  "26": 3424,
  "27": 3424,
  "1": 2048,
  "6": 2048,
  "8": 2048,
  "4": 1296,
  "5": 1296,
  "9": 1296,
  "10": 1296,
  "17": 2352,
  "18": 2544,
  "19": 2544,
  "20": 1344,
};

type House = { members?: string[]; start?: number | null; end?: number | null };
export type SpeedRecord = { date: string; member: string; minutes: number; plants: number };

const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

/** 記録から、人ごとの速さ（1,000株あたりの分）と全員の平均を出す（新しい記録から順に使う） */
export function speedsFrom(records: SpeedRecord[]): { speeds: Record<string, number>; counts: Record<string, number>; avg: number | null } {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  const by = new Map<string, SpeedRecord[]>();
  for (const r of sorted) by.set(r.member, [...(by.get(r.member) ?? []), r]);
  const rate = (rs: SpeedRecord[]) => {
    const p = rs.reduce((n, r) => n + r.plants, 0);
    return p > 0 ? Math.round((rs.reduce((n, r) => n + r.minutes, 0) / p) * 1000 * 10) / 10 : null;
  };
  const speeds: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [m, rs] of by) {
    const r = rate(rs.slice(0, PER_PERSON));
    if (r != null) {
      speeds[m] = r;
      counts[m] = Math.min(rs.length, PER_PERSON);
    }
  }
  return { speeds, counts, avg: rate(sorted.slice(0, ALL)) };
}

/** 収穫管理を使える人（スタッフ・管理者・従業員）だけが呼べる。計算して保存するだけ */
export const refreshHarvestSpeeds = onCall(async (req) => {
  const uid = req.auth?.uid;
  const role = req.auth?.token.role;
  if (!uid || (role !== "admin" && role !== "staff" && role !== "worker")) throw new HttpsError("permission-denied", "使えません");

  const today = ymd(new Date());
  const from = ymd(new Date(Date.now() - DAYS * 86400e3));
  const [cfg, harvest, uses, before, haichi] = await Promise.all([
    db.doc("config/harvest").get(),
    db.collection("harvest").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", today).get(),
    db.collection("houseUse").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", today).get(),
    // 期間の前の、いちばん近い記録（90日前まで。新しい順に読む方法は使えないので、まとめて読んで最後を使う）
    db
      .collection("houseUse")
      .where(FieldPath.documentId(), ">=", ymd(new Date(Date.now() - (DAYS + 90) * 86400e3)))
      .where(FieldPath.documentId(), "<", from)
      .get(),
    db.collection("haichi").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", today).get(),
  ]);
  // 日付 → その日の集荷係
  const pickupOf = new Map(
    haichi.docs.map((d) => [d.id, new Set(((d.get("cells") as Record<string, { members?: string[] }> | undefined)?.pickup?.members ?? []) as string[])]),
  );
  const plants = (cfg.get("plants") as Record<string, number> | undefined) ?? DEFAULT_PLANTS;
  const useByDate = new Map(uses.docs.map((d) => [d.id, (d.get("houses") as Record<string, string>) ?? {}]));
  let cur: Record<string, string> = (before.docs[before.docs.length - 1]?.get("houses") as Record<string, string>) ?? {};

  const records: SpeedRecord[] = [];
  for (const d of [...harvest.docs].sort((a, b) => a.id.localeCompare(b.id))) {
    // その日のハウスの使い方（記録がない日は前の日のまま）
    for (const [date, u] of useByDate) if (date <= d.id) cur = u;
    const houses = (d.get("houses") as Record<string, House>) ?? {};
    const brk = d.get("break") as { start?: number; minutes?: number } | undefined;
    for (const [h, r] of Object.entries(houses)) {
      if (r.members?.length !== 1 || r.start == null || r.end == null || r.end <= r.start) continue;
      if (pickupOf.get(d.id)?.has(r.members[0])) continue; // その日の集荷係は入れない
      const use = cur[h] ?? "harvest";
      const p = (plants[h] ?? 0) * (use === "harvest" ? 1 : use === "half" || use === "halfBack" ? 0.5 : 0);
      // 休憩の時間は抜く（その日の休憩。なければふだんの 9:00〜15分）
      const bs = typeof brk?.start === "number" ? brk.start : 540;
      const be = bs + (typeof brk?.minutes === "number" ? brk.minutes : 15);
      const minutes = r.end - r.start - Math.max(0, Math.min(r.end, be) - Math.max(r.start, bs));
      if (p > 0 && minutes > 0) records.push({ date: d.id, member: r.members[0], minutes, plants: p });
    }
  }
  const { speeds, counts, avg } = speedsFrom(records);
  await db.doc("stats/harvestSpeed").set({ speeds, counts, avg, records: records.length, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/** 収穫しない使い方（応援の行き先にしない） */
const NO_HARVEST = ["picking", "reserve", "off"];
type ForecastHouse = { start?: number | null; end?: number | null };
type Taps = Record<string, Record<string, { start?: number | null; end?: number | null }>>;

/**
 * 応援の行き先：まだ誰も入っていないハウスのうち、朝の予測でいちばん遅く終わるハウス。
 * 入った・終わったの時刻があるハウスと、だれかが収穫報告で押したハウスは除く
 */
export function pickHelpHouse(fh: Record<string, ForecastHouse>, houses: Record<string, House>, taps: Taps, usage: Record<string, string>): string | null {
  const tapped = new Set(
    Object.values(taps).flatMap((t) =>
      Object.entries(t)
        .filter(([, v]) => v?.start != null || v?.end != null)
        .map(([h]) => h),
    ),
  );
  let best: string | null = null;
  for (const [h, f] of Object.entries(fh)) {
    if (f?.end == null || NO_HARVEST.includes(usage[h] ?? "harvest") || tapped.has(h)) continue;
    if (houses[h]?.start != null || houses[h]?.end != null) continue;
    const b = best == null ? null : fh[best];
    if (b == null || f.end! > b.end! || (f.end === b.end && (f.start ?? 0) > (b.start ?? 0))) best = h;
  }
  return best;
}

/** 収穫報告：自分の予定が全部終わった人に、応援に行くハウスを返す（収穫者は収穫管理の記録を読めないので、番号だけ渡す） */
export const harvestHelpHouse = onCall(async (req) => {
  const uid = req.auth?.uid;
  if (!uid || req.auth?.token.role !== "worker") throw new HttpsError("permission-denied", "使えません");
  const w = await db.doc(`workers/${uid}`).get();
  if (w.get("active") !== true) throw new HttpsError("permission-denied", "使えません");
  const date = ymd(new Date());
  const [day, taps, use] = await Promise.all([
    db.doc(`harvest/${date}`).get(),
    db.collection(`harvest/${date}/taps`).get(),
    // ハウスの使い方は、その日の記録がなければ前の日（いちばん近い記録。60日前まで）を引きつぐ
    db
      .collection("houseUse")
      .where(FieldPath.documentId(), ">=", ymd(new Date(Date.now() - 60 * 86400e3)))
      .where(FieldPath.documentId(), "<=", date)
      .get(),
  ]);
  const fh = (day.get("forecastHouses") as Record<string, ForecastHouse> | undefined) ?? {};
  const houses = (day.get("houses") as Record<string, House> | undefined) ?? {};
  const t: Taps = Object.fromEntries(taps.docs.map((d) => [d.id, d.get("houses") ?? {}]));
  const usage = (use.docs[use.docs.length - 1]?.get("houses") as Record<string, string> | undefined) ?? {};
  return { house: pickHelpHouse(fh, houses, t, usage), forecast: Object.keys(fh).length > 0 };
});
