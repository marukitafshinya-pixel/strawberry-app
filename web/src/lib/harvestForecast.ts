"use client";

// 収穫終了の予測：ハウスの株数（大きさ）と、収穫する人の速さ（1,000株あたりの分）から、ハウスごとの終わる時刻と収穫終了を予測する。
// まだ終わっていないハウスは、同じまとまり（①〜⑧）でその日に終わったハウスの実績の速さで予測する（実の量はまとまりごとに近いため）。
// その日にまだどこも終わっていなければ、人ごとの過去の速さ（サーバーが毎日の記録から計算した stats/harvestSpeed）を使う。
// 朝の予測（forecast）は harvest/{日付} に残し、実際の収穫終了と比べて誤差を見られるようにする
import { collection, doc, documentId, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";
import {
  groupOf,
  houseMinutes,
  round1,
  readBreak,
  readForecastHouses,
  type ForecastHouses,
  type HarvestBreak,
  type HarvestDoc,
  type HouseGroup,
  type HouseUse,
} from "./harvest";

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
  /** その日の休憩（この時間は収穫しない） */
  brk: HarvestBreak;
  /** その日の速さの実績に入れないハウス（集荷係が収穫にも入ったハウスなど） */
  skipRate?: (h: string) => boolean;
  /** 応援を入れないハウス（病気などで、決めた人しか入れない） */
  noHelp?: (h: string) => boolean;
};

export type Forecast = {
  /** ハウス → 終わる予測（分、応援なし）。終わったハウスは入らない */
  houseEnd: Record<string, number>;
  /** ハウス → 入る予測（分）。「入った」がまだ入っていないハウスだけ（前のハウスの終わる予測から） */
  houseStart: Record<string, number>;
  /** 収穫終了の予測（分、早く終えた人の応援もふくむ）。予測できなければ null */
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
    return r?.start != null && r.end != null && r.end > r.start && eff(h) > 0 && f.who(h).length > 0 && !f.skipRate?.(h);
  });
  type Acc = { personMin: number; plants: number };
  const byGroup = new Map<string, Acc>();
  const all: Acc = { personMin: 0, plants: 0 };
  for (const h of done) {
    const r = f.rec[h];
    const personMin = houseMinutes(r, f.brk)! * f.who(h).length;
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

  /** その人がそのハウスで1株を収穫するのにかかる分（その日の実績を、人ごとの速さのちがいで直す。なければ過去の速さ） */
  const minPerPlant = (m: string, h: string): number | null => {
    const today = todayRate(h);
    const pr = personRate(m);
    if (today != null) return pr != null && avgRate ? (today * pr) / avgRate : today;
    return pr;
  };

  // ---- 1分ずつ、だれがどのハウスをどれだけ進めるかを順に計算する（シミュレーション）
  // help のときは、自分の回るハウスを全部終えた人が、そのとき収穫中でいちばん終わるのがおそいハウスへ応援に行く
  const simulate = (help: boolean) => {
    type House = { remaining: number; team: Set<string>; started: number | null; fin: number | null };
    const hs = new Map<string, House>();
    for (const h of f.houses)
      if (eff(h) > 0 && f.rec[h]?.end == null) hs.set(h, { remaining: eff(h), team: new Set(), started: f.rec[h]?.start ?? null, fin: null });
    type Person = { id: string; queue: string[]; at: string | null; free: number | null };
    const persons: Person[] = [];
    const unknown = new Set<string>();
    const people = [...new Set(f.houses.flatMap((h) => (eff(h) > 0 ? f.who(h) : [])))];
    for (const m of people) {
      // その人の回る順：矢印の順のあとに、ほかに入っているハウス（作業配置表の順）
      const route = (f.routes[m] ?? []).filter((h) => f.who(h).includes(m));
      const seq = [...route, ...f.houses.filter((h) => !route.includes(h) && f.who(h).includes(m))].filter((h) => eff(h) > 0);
      const queue = seq.filter((h) => hs.has(h));
      if (!queue.length) continue;
      // 動き出せる時刻：最初の残りのハウスの「入った」→ 前のハウスの「終わった」→ 予定の開始時刻
      const lastEnd = seq.reduce<number | null>((n, h) => (f.rec[h]?.end != null ? Math.max(n ?? 0, f.rec[h].end!) : n), null);
      const free = f.rec[queue[0]]?.start ?? lastEnd ?? f.startOf(queue[0]);
      if (free == null || queue.some((h) => minPerPlant(m, h) == null)) {
        queue.forEach((h) => unknown.add(h));
        continue;
      }
      persons.push({ id: m, queue, at: null, free });
    }
    const bStart = f.brk.start;
    const bEnd = f.brk.start + f.brk.minutes;
    const t0 = persons.length ? Math.min(...persons.map((p) => p.free!)) : 0;
    const open = () => [...hs.values()].some((x) => x.fin == null);
    for (let t = t0; persons.length && open() && t < t0 + 24 * 60; t++) {
      if (t >= bStart && t < bEnd) continue; // 休憩中はだれも進めない
      // 手があいた人を、次のハウスへ（なければ応援へ）
      for (const p of persons) {
        if (p.at != null || p.free == null || t < p.free) continue;
        while (p.queue.length && hs.get(p.queue[0])!.fin != null) p.queue.shift();
        let target = p.queue.shift() ?? null;
        if (!target && !help) {
          p.free = null; // 応援なし：自分のハウスを終えたらおしまい
          continue;
        }
        if (!target) {
          // 応援：収穫中のハウスのうち、いまのままだといちばん終わるのがおそいところ
          let worst = -1;
          for (const [h, x] of hs) {
            if (x.fin != null || x.team.size === 0 || minPerPlant(p.id, h) == null || f.noHelp?.(h)) continue;
            const rate = [...x.team].reduce((n, m) => n + 1 / minPerPlant(m, h)!, 0);
            const left = x.remaining / rate;
            if (left > worst) [worst, target] = [left, h];
          }
          if (!target) {
            // いま収穫中のハウスがなければ、1分後にもう一度さがす（ほかの人がこれから入るハウスを手伝えるように）
            p.free = t + 1;
            continue;
          }
        }
        const x = hs.get(target)!;
        x.team.add(p.id);
        if (x.started == null) x.started = t;
        p.at = target;
      }
      // 1分ぶん進める
      for (const [h, x] of hs) {
        if (x.fin != null || x.team.size === 0) continue;
        x.remaining -= [...x.team].reduce((n, m) => n + 1 / minPerPlant(m, h)!, 0);
        // まだ終わっていないハウスは、今より前には終わらない
        if (x.remaining <= 0 && !(f.now != null && t + 1 < f.now)) {
          x.fin = t + 1;
          for (const p of persons) if (p.at === h) [p.at, p.free] = [null, t + 1];
          x.team.clear();
        } else if (x.remaining <= 0) x.remaining = 1e-6;
      }
    }
    const houseEnd: Record<string, number> = {};
    const houseStart: Record<string, number> = {};
    for (const [h, x] of hs) {
      if (x.fin != null) houseEnd[h] = x.fin;
      else if (f.who(h).length) unknown.add(h);
      // 「入った」がまだなら、入る予測を残す
      if (f.rec[h]?.start == null && x.started != null) houseStart[h] = x.started;
    }
    return { houseEnd, houseStart, unknown };
  };
  // ハウスごとの予測は応援なし、収穫終了の予測だけ応援ありで出す
  const { houseEnd, houseStart, unknown } = simulate(false);
  const helped = simulate(true);
  const unassigned = f.houses.filter((h) => eff(h) > 0 && f.who(h).length === 0 && f.rec[h]?.end == null);
  const ended = f.houses.filter((h) => f.rec[h]?.end != null && eff(h) > 0).map((h) => f.rec[h].end as number);
  const ends = [...Object.values(helped.houseEnd), ...ended];
  const pending = f.houses.filter((h) => eff(h) > 0 && f.who(h).length > 0 && f.rec[h]?.end == null);
  const end = ends.length && (pending.length === 0 || Object.keys(helped.houseEnd).length > 0) ? Math.max(...ends) : null;
  return { houseEnd, houseStart, end, unassigned, unknown: [...unknown].filter((h) => houseEnd[h] == null) };
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

/** 人ごとの速さと、収穫ケース数の見込みに使う数字を、毎日の記録から計算し直してもらう（サーバー） */
export const refreshHarvestSpeeds = () => callFunction("refreshHarvestSpeeds", {}).catch(() => {});

// ---------- 収穫ケース数の予測 ----------
// 朝（B）：まとまりごとの「1,000株あたりのケース数」（最近7日。サーバーが計算）× 株数 × 天気の影響（夜温・前の日の日照）。
// 収穫が始まったら（A）：終わったハウスの実際のケース数で直す。終わったハウスのあるまとまりはその日の実際の率、
// ないまとまりは朝の見込みに「その日の実の多さ」（終わったハウスの実際 ÷ 朝の見込み）をかける

/** サーバーが計算した、収穫ケース数の見込みに使う数字（stats/harvestYield） */
export type HarvestYield = {
  groups: Record<string, number>;
  all: number | null;
  days: number;
  factor: number;
  model: { n: number; a: number; b: number; c: number } | null;
  nightMin: number | null;
  sun: number | null;
  /** 去年の出荷実績から出した天気の影響を使っているとき：その季節の名前と出荷の回数 */
  prior: { season: string; n: number } | null;
};
export function useHarvestYield(): HarvestYield | null | undefined {
  const [v, setV] = useState<HarvestYield | null | undefined>(undefined);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "stats/harvestYield"),
        (s) =>
          setV(
            s.exists()
              ? {
                  groups: (s.get("groups") as Record<string, number>) ?? {},
                  all: typeof s.get("all") === "number" ? (s.get("all") as number) : null,
                  days: (s.get("days") as number) ?? 0,
                  factor: typeof s.get("factor") === "number" ? (s.get("factor") as number) : 1,
                  model: (s.get("model") as HarvestYield["model"]) ?? null,
                  nightMin: typeof s.get("nightMin") === "number" ? (s.get("nightMin") as number) : null,
                  sun: typeof s.get("sun") === "number" ? (s.get("sun") as number) : null,
                  prior: (s.get("prior") as HarvestYield["prior"]) ?? null,
                }
              : null,
          ),
        () => setV(null),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

export type CasesForecast = {
  /** 朝の見込み（記録がまだなければ null） */
  morning: number | null;
  /** 今の予測（終わったハウスの実際で直したもの。出せなければ null） */
  total: number | null;
  /** 終わったハウスの数 */
  ended: number;
};

/** 収穫ケース数の予測（朝の見込みと、終わったハウスの実際で直した予測） */
export function forecastCases(f: {
  houses: string[];
  rec: HarvestDoc;
  usage: (h: string) => HouseUse;
  plants: Record<string, number>;
  groups: HouseGroup[];
  yield: HarvestYield | null;
}): CasesForecast {
  const list = f.houses.map((h) => ({ h, p: harvestPlants(f.plants, h, f.usage(h)), g: groupOf(f.groups, h) })).filter((x) => x.p > 0);
  const y = f.yield;
  /** 朝の見込みの、1,000株あたりのケース数 */
  const morningRate = (g: string) => {
    const r = y?.groups[g] ?? y?.all;
    return r == null ? null : r * (y?.factor ?? 1);
  };
  const morningParts = list.map((x) => (morningRate(x.g) == null ? null : (x.p / 1000) * morningRate(x.g)!));
  const morning = y && morningParts.every((m) => m != null) ? round1(morningParts.reduce((n, m) => n! + m!, 0)!) : null;
  // 終わったハウスの実際
  const done = list.filter((x) => f.rec[x.h]?.end != null && (f.rec[x.h]?.cases ?? 0) > 0);
  const todayGroup = new Map<string, { cases: number; plants: number }>();
  for (const x of done) {
    const t = todayGroup.get(x.g) ?? { cases: 0, plants: 0 };
    todayGroup.set(x.g, { cases: t.cases + f.rec[x.h].cases!, plants: t.plants + x.p });
  }
  const doneCases = done.reduce((n, x) => n + f.rec[x.h].cases!, 0);
  const donePlants = done.reduce((n, x) => n + x.p, 0);
  const doneMorning = done.reduce((n, x) => n + (morningRate(x.g) == null ? 0 : (x.p / 1000) * morningRate(x.g)!), 0);
  /** その日の実の多さ（朝の見込みに対して） */
  const dayFactor = doneMorning > 0 ? doneCases / doneMorning : null;
  const rateNow = (g: string) => {
    const t = todayGroup.get(g);
    if (t && t.plants > 0) return (t.cases / t.plants) * 1000;
    const m = morningRate(g);
    if (m != null) return m * (dayFactor ?? 1);
    return donePlants > 0 ? (doneCases / donePlants) * 1000 : null;
  };
  let total: number | null = 0;
  for (const x of list) {
    const cases = f.rec[x.h]?.cases ?? 0;
    if (f.rec[x.h]?.end != null) {
      total += cases;
      continue;
    }
    const r = rateNow(x.g);
    if (r == null) {
      total = null;
      break;
    }
    // 収穫中のハウスは、もう数えた分より少なくはしない
    total += Math.max(cases, (x.p / 1000) * r);
  }
  return { morning, total: total == null ? null : round1(total), ended: done.length };
}

/** 朝の収穫ケース数の見込みを残す（実際と比べるため） */
export async function saveCasesForecast(date: string, casesForecast: number) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { casesForecast, updatedAt: serverTimestamp() }, { mergeFields: ["casesForecast", "updatedAt"] });
}

/** 朝の予測を残す（実際の収穫終了と比べるため） */
export async function saveHarvestForecast(date: string, forecast: number, forecastHouses: ForecastHouses) {
  const { db } = await getFirebase();
  // 予測の2つはまるごと置きかえる（前の予測にあったハウスが残らないように）。ほかの記録はそのまま
  await setDoc(
    doc(db, "harvest", date),
    { forecast, forecastHouses, updatedAt: serverTimestamp() },
    { mergeFields: ["forecast", "forecastHouses", "updatedAt"] },
  );
}

/** 期間の、日ごとの朝の予測と実際の収穫終了（管理者だけ）。日付 → { forecast, endTime } */
export type HarvestDayMeta = {
  forecast: number | null;
  endTime: number | null;
  brk: HarvestBreak | null;
  forecastHouses: ForecastHouses | null;
  /** 朝の収穫ケース数の見込み */
  casesForecast: number | null;
};
export function useHarvestEnds(from: string, to: string): Record<string, HarvestDayMeta> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; v: Record<string, HarvestDayMeta> } | null>(null);
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
                  brk: readBreak(d.get("break")),
                  forecastHouses: readForecastHouses(d.get("forecastHouses")),
                  casesForecast: typeof d.get("casesForecast") === "number" ? (d.get("casesForecast") as number) : null,
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
