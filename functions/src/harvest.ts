// 収穫管理：人ごとの収穫の速さ（1,000株あたりの分）を、最近の記録から計算して stats/harvestSpeed に保存する。
// スタッフや集荷係は過去の記録を読めないので、予測に使う速さだけをサーバーで計算して渡す。
// 使う記録：1人だけで収穫したハウスで、入った・終わった時刻があるもの（株数はハウスの大きさ。いちご狩り前・後ろは半分）
// その日の集荷係（作業配置表の「集荷係」の枠）が収穫にも入ったハウスは、集荷をしながらなので速さには入れない
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "./common.js";
import { helpCandidates, pickHelp, type HelpForecast, type HelpInput } from "./helpAssign.js";
import { yieldFrom, type YieldDay, type YieldWeather } from "./harvestYield.js";

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

type House = { members?: string[]; membersEdited?: boolean; start?: number | null; end?: number | null; cases?: number };

/** 画面側（web/src/lib/harvest.ts）と同じ、はじめのハウスのまとまり */
const DEFAULT_GROUPS: { name: string; houses: string[] }[] = [
  { name: "①", houses: ["21", "22"] },
  { name: "②", houses: ["23", "24"] },
  { name: "③", houses: ["25", "26"] },
  { name: "④", houses: ["27"] },
  { name: "⑤", houses: ["1", "6", "8"] },
  { name: "⑥", houses: ["4", "5", "9", "10"] },
  { name: "⑦", houses: ["17", "18"] },
  { name: "⑧", houses: ["19", "20"] },
];
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

  const groups = (cfg.get("groups") as { name: string; houses: string[] }[] | undefined) ?? DEFAULT_GROUPS;
  const groupOf = (h: string) => groups.find((g) => g.houses.includes(h))?.name ?? "その他";
  const records: SpeedRecord[] = [];
  /** 収穫ケース数の見込み用：日ごと・まとまりごとの、終わったハウスのケース数と株数 */
  const yieldDays: YieldDay[] = [];
  for (const d of [...harvest.docs].sort((a, b) => a.id.localeCompare(b.id))) {
    // その日のハウスの使い方（記録がない日は前の日のまま）
    for (const [date, u] of useByDate) if (date <= d.id) cur = u;
    const houses = (d.get("houses") as Record<string, House>) ?? {};
    const yd: YieldDay = { date: d.id, groups: {} };
    for (const [h, r] of Object.entries(houses)) {
      const use = cur[h] ?? "harvest";
      const p = (plants[h] ?? 0) * (use === "harvest" ? 1 : use === "half" || use === "halfBack" ? 0.5 : 0);
      if (r.end == null || !(p > 0) || !((r.cases ?? 0) > 0)) continue;
      const g = (yd.groups[groupOf(h)] ??= { cases: 0, plants: 0 });
      g.cases += r.cases!;
      g.plants += p;
    }
    yieldDays.push(yd);
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

  // 収穫ケース数の見込み（まとまりごとの 1,000株あたりのケース数と、夜温・日照の影響）
  const months = new Set<string>();
  for (let t = Date.parse(`${from}T00:00:00Z`) - 86400e3; t <= Date.parse(`${today}T00:00:00Z`); t += 86400e3)
    months.add(new Date(t).toISOString().slice(0, 7));
  const weather: YieldWeather = {};
  for (const ym of months) {
    const days = ((await db.doc(`weather/${ym}`).get()).get("days") as Record<string, { nightMin?: number | null; sun?: number | null }> | undefined) ?? {};
    for (const [dd, w] of Object.entries(days)) weather[`${ym}-${dd}`] = w;
  }
  await db.doc("stats/harvestYield").set({ ...yieldFrom(yieldDays, weather, today), forDate: today, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

type Taps = Record<string, Record<string, { start?: number | null; end?: number | null }>>;

/** 応援の割り当てを覚えておく場所（サーバーだけが読み書きする。画面からは読めない） */
const assignDoc = (date: string) => db.doc(`harvest/${date}/helpAssign/all`);

/**
 * 収穫報告：応援先、もう終わったハウス、集荷係が入れ直した収穫者を返す（収穫者は収穫管理の記録を読めないので、必要なものだけ渡す）。
 * 自分の予定が終わった従業員（free）には、応援先を割り当てる（そのハウスが終わるまで変えない）。
 * assign＝みんなの応援先（収穫管理の指示一覧・収穫報告の画面を見るときに使う）、open＝終わっていないハウスがあるか
 */
export const harvestHelpHouse = onCall(async (req) => {
  const uid = req.auth?.uid;
  const role = req.auth?.token.role;
  // 収穫する従業員と、収穫管理から収穫報告の画面を見るスタッフ・管理者
  if (!uid || (role !== "worker" && role !== "admin" && role !== "staff")) throw new HttpsError("permission-denied", "使えません");
  const w = await db.doc(role === "worker" ? `workers/${uid}` : `staff/${uid}`).get();
  if (w.get("active") !== true) throw new HttpsError("permission-denied", "使えません");
  const me = role === "worker" ? ((w.get("memberId") as string | undefined) ?? null) : null;
  const free = (req.data as { free?: unknown } | undefined)?.free === true;
  const date = ymd(new Date());
  const jst = new Date(Date.now() + 9 * 3600e3);
  const now = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const [day, taps, use, cfg, speed] = await Promise.all([
    db.doc(`harvest/${date}`).get(),
    db.collection(`harvest/${date}/taps`).get(),
    // ハウスの使い方は、その日の記録がなければ前の日（いちばん近い記録。60日前まで）を引きつぐ
    db
      .collection("houseUse")
      .where(FieldPath.documentId(), ">=", ymd(new Date(Date.now() - 60 * 86400e3)))
      .where(FieldPath.documentId(), "<=", date)
      .get(),
    db.doc("config/harvest").get(),
    db.doc("stats/harvestSpeed").get(),
  ]);
  const noHelp = (cfg.get("noHelp") as string[] | undefined) ?? [];
  const fh = (day.get("forecastHouses") as Record<string, HelpForecast> | undefined) ?? {};
  const houses = (day.get("houses") as Record<string, House> | undefined) ?? {};
  const t: Taps = Object.fromEntries(taps.docs.map((d) => [d.id, d.get("houses") ?? {}]));
  const usage = (use.docs[use.docs.length - 1]?.get("houses") as Record<string, string> | undefined) ?? {};
  const input: HelpInput = {
    now,
    fh,
    houses,
    taps: t,
    usage,
    noHelp,
    plants: (cfg.get("plants") as Record<string, number> | undefined) ?? DEFAULT_PLANTS,
    avg: typeof speed.get("avg") === "number" ? (speed.get("avg") as number) : null,
    assigns: {},
  };
  const open = helpCandidates(input);
  /** まだ使える割り当て：そのハウスが終わっていなくて、その人がそこで「終わった」を押していなくて、ほかのハウスで収穫中でない */
  const valid = (id: string, h: string | undefined) =>
    !!h && open.includes(h) && t[id]?.[h]?.end == null && !Object.entries(t[id] ?? {}).some(([x, v]) => x !== h && v?.start != null && v?.end == null);
  const assign = await db.runTransaction(async (tx) => {
    const raw = ((await tx.get(assignDoc(date))).get("assign") as Record<string, { house: string; at: number }> | undefined) ?? {};
    const cur: Record<string, { house: string; at: number }> = Object.fromEntries(Object.entries(raw).filter(([id, a]) => valid(id, a?.house)));
    let changed = Object.keys(cur).length !== Object.keys(raw).length;
    if (me && free && !cur[me]) {
      // 手のあいた人に、応援先を割り当てる（ほかの人の割り当ても人数に数える）
      const h = pickHelp({ ...input, assigns: Object.fromEntries(Object.entries(cur).map(([id, a]) => [id, a.house])) }, me);
      if (h) {
        cur[me] = { house: h, at: Date.now() };
        changed = true;
      }
    }
    if (changed) tx.set(assignDoc(date), { assign: cur, updatedAt: FieldValue.serverTimestamp() });
    return Object.fromEntries(Object.entries(cur).map(([id, a]) => [id, a.house]));
  });
  // done＝もう終わったハウス（「ほかのハウスに行く」の一覧から外す）
  const done = Object.entries(houses)
    .filter(([, v]) => v?.end != null)
    .map(([h]) => h);
  // 集荷係が収穫管理で人を入れ直したハウスの収穫者（作業配置表より優先する。名前の id だけ渡す）
  const members = Object.fromEntries(
    Object.entries(houses)
      .filter(([, v]) => v?.membersEdited && Array.isArray(v.members))
      .map(([h, v]) => [h, v.members!]),
  );
  return { house: me ? (assign[me] ?? null) : null, assign, open: open.length > 0, forecast: Object.keys(fh).length > 0, done, members };
});
