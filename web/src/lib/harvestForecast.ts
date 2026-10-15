"use client";

// 収穫終了の予測：ハウスの株数（大きさ）と、収穫する人の速さ（1,000株あたりの分）から、ハウスごとの終わる時刻と収穫終了を予測する。
// まだ終わっていないハウスは、同じまとまり（①〜⑧）でその日に終わったハウスの実績の速さで予測する（実の量はまとまりごとに近いため）。
// その日にまだどこも終わっていなければ、人ごとの過去の速さ（サーバーが毎日の記録から計算した stats/harvestSpeed）を使う。
// 朝の予測（forecast）は harvest/{日付} に残し、実際の収穫終了と比べて誤差を見られるようにする
import { collection, doc, documentId, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";
import { groupOf, type HarvestDoc, type HouseGroup, type HouseUse } from "./harvest";

/** 収穫する株数（いちご狩り前・後ろは半分。収穫しない使い方は 0） */
export function harvestPlants(plants: Record<string, number>, house: string, use: HouseUse): number {
  const p = plants[house] ?? 0;
  if (use === "harvest") return p;
  if (use === "half" || use === "halfBack") return p / 2;
  return 0;
}

/** 人ごとの速さ（1,000株あたりの分）と、全員の平均 */
export type HarvestSpeeds = { speeds: Record<string, number>; avg: number | null };

export type ForecastInput = {
  /** 作業配置表の収穫の枠の順 */
  houses: string[];
  /** 人 → 回るハウスの順（作業配置表の矢印から） */
  routes: Record<string, string[]>;
  /** ハウスの収穫者 */
  who: (h: string) => string[];
  rec: HarvestDoc;
  usage: (h: string) => HouseUse;
  plants: Record<string, number>;
  groups: HouseGroup[];
  speed: HarvestSpeeds;
  /** そのハウスの「入った」（予定の開始時刻もふくむ） */
  startOf: (h: string) => number | null;
  /** 今の時刻（分）。今日でなければ null */
  now: number | null;
};

export type Forecast = {
  /** ハウス → 終わる予測（分）。終わったハウスは入らない */
  houseEnd: Record<string, number>;
  /** ハウス → 入る予測（分）。「入った」がまだ入っていないハウスだけ（前のハウスの終わる予測から） */
  houseStart: Record<string, number>;
  /** 収穫終了の予測（分）。予測できなければ null */
  end: number | null;
  /** 収穫者が決まっていない、まだ終わっていないハウス */
  unassigned: string[];
  /** 予測できなかったハウス（速さのデータがない、入った時刻がわからない） */
  unknown: string[];
};

/**
 * 収穫終了を予測する。
 * 1人あたりの速さ（1株あたり何分、何人で入ったかをかけた「のべ時間」で数える）を、
 * ① 同じまとまりでその日に終わったハウス ② その日に終わったほかのハウス ③ 人ごとの過去の速さ（なければ全員の平均）の順に使う
 */
export function forecastHarvest(f: ForecastInput): Forecast {
  const eff = (h: string) => harvestPlants(f.plants, h, f.usage(h));
  // その日に終わったハウスから、まとまりごと・全体の「のべ分 ÷ 株数」と「実際 ÷ 過去の速さからの予測」を出す
  const done = f.houses.filter((h) => {
    const r = f.rec[h];
    return r?.start != null && r.end != null && r.end > r.start && eff(h) > 0 && f.who(h).length > 0;
  });
  type Acc = { personMin: number; plants: number };
  const byGroup = new Map<string, Acc>();
  const all: Acc = { personMin: 0, plants: 0 };
  for (const h of done) {
    const r = f.rec[h];
    const personMin = (r.end! - r.start!) * f.who(h).length;
    const g = groupOf(f.groups, h);
    const a = byGroup.get(g) ?? { personMin: 0, plants: 0 };
    a.personMin += personMin;
    a.plants += eff(h);
    byGroup.set(g, a);
    all.personMin += personMin;
    all.plants += eff(h);
  }
  /** その日の実績の、1人で1株にかかる分（まとまり → 全体） */
  const todayRate = (h: string) => {
    const a = byGroup.get(groupOf(f.groups, h));
    if (a && a.plants > 0) return a.personMin / a.plants;
    return all.plants > 0 ? all.personMin / all.plants : null;
  };
  /** 人の過去の速さ（1株あたりの分） */
  const personRate = (m: string) => {
    const s = f.speed.speeds[m] ?? f.speed.avg;
    return s != null ? s / 1000 : null;
  };
  /** 全員の過去の速さの平均（1株あたりの分） */
  const avgRate = f.speed.avg != null ? f.speed.avg / 1000 : null;

  /** そのハウスにかかる時間の予測（分） */
  const duration = (h: string): number | null => {
    const ms = f.who(h);
    const p = eff(h);
    if (!ms.length || p <= 0) return null;
    const today = todayRate(h);
    if (today != null) {
      // その日の実績の速さを、人ごとの速さのちがいで少し直す（速い人は短く）
      const rates = ms.map((m) => {
        const pr = personRate(m);
        return pr != null && avgRate ? (today * pr) / avgRate : today;
      });
      return p / rates.reduce((n, r) => n + 1 / r, 0);
    }
    const rates = ms.map(personRate);
    if (rates.some((r) => r == null)) return null;
    return p / rates.reduce<number>((n, r) => n + 1 / (r as number), 0);
  };

  const houseEnd: Record<string, number> = {};
  const houseStart: Record<string, number> = {};
  const unknown = new Set<string>();
  const people = [...new Set(f.houses.flatMap((h) => (eff(h) > 0 ? f.who(h) : [])))];
  for (const m of people) {
    // その人の回る順：矢印の順のあとに、ほかに入っているハウス（作業配置表の順）
    const route = (f.routes[m] ?? []).filter((h) => f.who(h).includes(m));
    const seq = [...route, ...f.houses.filter((h) => !route.includes(h) && f.who(h).includes(m))].filter((h) => eff(h) > 0);
    let cursor: number | null = null;
    for (const h of seq) {
      const r = f.rec[h] ?? {};
      if (r.end != null) {
        cursor = Math.max(cursor ?? 0, r.end);
        continue;
      }
      const start: number | null = r.start ?? cursor ?? f.startOf(h);
      const d = duration(h);
      if (start == null || d == null) {
        unknown.add(h);
        cursor = null;
        continue;
      }
      let fin: number = start + d;
      // まだ終わっていないのに予測の時刻を過ぎていたら、今を終わる時刻とする（あとのハウスもそこから数える）
      if (f.now != null && fin < f.now) fin = f.now;
      houseEnd[h] = Math.max(houseEnd[h] ?? 0, Math.round(fin));
      // 「入った」がまだなら、入る予測（前のハウスの終わる予測）を残す。何人かで入るときは、いちばん早い人の時刻
      if (r.start == null) houseStart[h] = Math.min(houseStart[h] ?? Infinity, Math.round(start));
      cursor = fin;
    }
  }
  const unassigned = f.houses.filter((h) => eff(h) > 0 && f.who(h).length === 0 && f.rec[h]?.end == null);
  const ended = f.houses.filter((h) => f.rec[h]?.end != null && eff(h) > 0).map((h) => f.rec[h].end as number);
  const ends = [...Object.values(houseEnd), ...ended];
  const pending = f.houses.filter((h) => eff(h) > 0 && f.who(h).length > 0 && f.rec[h]?.end == null);
  const end = ends.length && (pending.length === 0 || Object.keys(houseEnd).length > 0) ? Math.max(...ends) : null;
  return { houseEnd, houseStart, end, unassigned, unknown: [...unknown] };
}

/** 人ごとの速さ（サーバーが計算したもの） */
export function useHarvestSpeeds(): HarvestSpeeds | null {
  const [v, setV] = useState<HarvestSpeeds | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "stats/harvestSpeed"),
        (s) =>
          setV({
            speeds: (s.get("speeds") as Record<string, number> | undefined) ?? {},
            avg: typeof s.get("avg") === "number" ? (s.get("avg") as number) : null,
          }),
        () => setV({ speeds: {}, avg: null }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

/** 人ごとの速さを、毎日の記録から計算し直してもらう（サーバー） */
export const refreshHarvestSpeeds = () => callFunction("refreshHarvestSpeeds", {}).catch(() => {});

/** 朝の予測を残す（実際の収穫終了と比べるため） */
export async function saveHarvestForecast(date: string, forecast: number) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { forecast, updatedAt: serverTimestamp() }, { merge: true });
}

/** 期間の、日ごとの朝の予測と実際の収穫終了（管理者だけ）。日付 → { forecast, endTime } */
export function useHarvestEnds(from: string, to: string): Record<string, { forecast: number | null; endTime: number | null }> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; v: Record<string, { forecast: number | null; endTime: number | null }> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "harvest"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) =>
          setState({
            key,
            v: Object.fromEntries(
              snap.docs.map((d) => [
                d.id,
                {
                  forecast: typeof d.get("forecast") === "number" ? (d.get("forecast") as number) : null,
                  endTime: typeof d.get("endTime") === "number" ? (d.get("endTime") as number) : null,
                },
              ]),
            ),
          }),
        () => setState({ key, v: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [from, to, key]);
  return state && state.key === key ? state.v : null;
}
