"use client";

// 収穫管理（棟別出荷調査票）：ハウスごとに、その日の収穫者・入った時刻・終わった時刻・確定数（ケース）を記録する（harvest/{YYYY-MM-DD}）。
// ケースは集荷のたびに「＋1」を押して数え、押すたびにすぐ保存する（どの端末でも同じ数になる）。
// その日のハウスの使い方（収穫・いちご狩り・半分・予備・休み）は houseUse/{YYYY-MM-DD}。記録がない日は前の日の状態を引きつぐ。
// 1ケースあたりの時間は、1人だけで収穫したハウスで計算する（途中で応援が入ったハウスは、ケース数だけ数える）。実績は管理者だけが見られる。
import { collection, doc, documentId, increment, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { sectionArrows, sectionSide, type HaichiDay, type HaichiTemplate } from "./haichi";

/** 1つのハウスのその日の記録。start・end は0時からの分、cases は確定数（0.1枚単位） */
/** membersEdited＝収穫管理の画面で収穫者を手で変えた（作業配置表に合わせない） */
export type HouseHarvest = { members?: string[]; membersEdited?: boolean; start?: number | null; end?: number | null; cases?: number };
/** ハウスの名前 → 記録 */
export type HarvestDoc = Record<string, HouseHarvest>;

/** half＝いちご狩り前（前半分がいちご狩り・後ろ半分は収穫）、halfBack＝いちご狩り後ろ（後ろ半分がいちご狩り・前半分は収穫） */
export type HouseUse = "harvest" | "picking" | "half" | "halfBack" | "reserve" | "off";
export const HOUSE_USES: { key: HouseUse; label: string; short: string; cls: string }[] = [
  { key: "harvest", label: "収穫", short: "収", cls: "bg-rose-100 text-rose-900 border-rose-300" },
  { key: "picking", label: "いちご狩り全", short: "狩全", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  { key: "half", label: "いちご狩り前（後ろ半分は収穫）", short: "狩前", cls: "bg-gradient-to-r from-emerald-100 to-rose-100 text-gray-900 border-amber-300" },
  {
    key: "halfBack",
    label: "いちご狩り後ろ（前半分は収穫）",
    short: "狩後",
    cls: "bg-gradient-to-r from-rose-100 to-emerald-100 text-gray-900 border-amber-300",
  },
  { key: "reserve", label: "いちご狩り予備（収穫を止めている）", short: "狩予", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  { key: "off", label: "休み", short: "－", cls: "bg-gray-100 text-gray-500 border-gray-300" },
];
export const houseUseOf = (k: string | undefined) => HOUSE_USES.find((u) => u.key === k) ?? HOUSE_USES[0];

/** ハウスのまとまり（集計で使う）。houses はハウスの名前（作業配置表の枠の名前と同じ） */
export type HouseGroup = { name: string; houses: string[] };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
export const DEFAULT_GROUPS: HouseGroup[] = [
  { name: "①", houses: ["21", "22"] },
  { name: "②", houses: ["23", "24"] },
  { name: "③", houses: ["25", "26"] },
  { name: "④", houses: ["27"] },
  { name: "⑤", houses: ["1", "6", "8"] },
  { name: "⑥", houses: ["4", "5", "9", "10"] },
  { name: "⑦", houses: ["17", "18"] },
  { name: "⑧", houses: range(19, 20) },
];

/** ハウスの株数（ハウスの大きさとして、収穫時間の予測に使う）。管理者が画面で直せる */
export const DEFAULT_PLANTS: Record<string, number> = {
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

/** 作業配置表の収穫の枠から、ハウスの名前を並べる */
export function harvestHouses(t: HaichiTemplate): string[] {
  const out: string[] = [];
  for (const s of t.sections) if (sectionArrows(s)) for (const sl of s.slots) if (!out.includes(sl.label)) out.push(sl.label);
  return out;
}

/** 作業配置表から読み取った、その日の収穫の予定 */
export type HarvestPlan = {
  /** ハウス → 収穫者（配置表で名前が入っているハウスと、矢印の先で名前のないハウス） */
  members: Record<string, string[]>;
  /** 人 → 回るハウスの順（矢印をたどった順。最初のハウスが先頭） */
  routes: Record<string, string[]>;
};

/** 矢印の向き（横 dx：−1＝左・＋1＝右、縦 dy：−1＝上・＋1＝下） */
const ARROW_DIR: Record<string, [number, number]> = {
  "→": [1, 0],
  "←": [-1, 0],
  "↑": [0, -1],
  "↓": [0, 1],
  "↗": [1, -1],
  "↘": [1, 1],
  "↙": [-1, 1],
  "↖": [-1, -1],
};

/**
 * 作業配置表の矢印をたどって、だれがどのハウスをどの順に回るかを読む。
 * 配置表は左右2列で、矢印は次に向かうハウスを指す（↓＝同じ列の1つ下、←＝左の列）。左右に動くときは、メモに「8番へ」とあればそのハウス、なければ同じ高さのハウス。
 * 名前の入っていないハウスでも、矢印でつながっていれば同じ人が回る
 */
export function planHarvest(t: HaichiTemplate, day: HaichiDay): HarvestPlan {
  const cols: Record<"left" | "right", { id: string; label: string }[]> = { left: [], right: [] };
  for (const s of t.sections) if (sectionArrows(s)) cols[sectionSide(s)].push(...s.slots);
  const where = new Map<string, { side: "left" | "right"; i: number; id: string }>();
  for (const side of ["left", "right"] as const) cols[side].forEach((sl, i) => where.set(sl.label, { side, i, id: sl.id }));
  const cellOf = (label: string) => day.cells[where.get(label)?.id ?? ""];
  const listed = (label: string) => cellOf(label)?.members ?? [];
  /** そのハウスの矢印の先のハウス（なければ null） */
  const nextOf = (label: string): string | null => {
    const c = cellOf(label);
    const pos = where.get(label);
    const dir = c?.arrow ? ARROW_DIR[c.arrow] : undefined;
    if (!c || !pos || !dir) return null;
    const [dx, dy] = dir;
    let side = pos.side;
    if (dx !== 0) {
      const to = dx > 0 ? "right" : "left";
      if (to === side) return null;
      side = to;
      const named = /(\d+)\s*番/.exec(c.memo ?? "")?.[1];
      if (named && where.get(named)?.side === side) return named;
    }
    return cols[side][pos.i + dy]?.label ?? null;
  };
  /** label から矢印をたどる（名前の入っていないハウスか、同じ人の名前があるハウスだけ進む） */
  const follow = (m: string, label: string) => {
    const route = [label];
    for (let cur = nextOf(label); cur && !route.includes(cur); cur = nextOf(cur)) {
      const others = listed(cur);
      if (others.length && !others.includes(m)) break;
      route.push(cur);
    }
    return route;
  };
  const order = [...cols.left, ...cols.right].map((sl) => sl.label);
  const people = [...new Set(order.flatMap(listed))];
  const members: Record<string, string[]> = {};
  const routes: Record<string, string[]> = {};
  for (const m of people) {
    const mine = order.filter((l) => listed(l).includes(m));
    // ほかのハウスの矢印の先になっていないハウスが、回りはじめのハウス
    const reached = new Set(mine.flatMap((l) => follow(m, l).slice(1)));
    const starts = mine.filter((l) => !reached.has(l));
    const chains = (starts.length ? starts : mine.slice(0, 1)).map((st) => follow(m, st));
    // 名前は、配置表に名前があるハウスと、矢印でたどれるハウスに入れる（矢印のないハウスへは、あとで名前を引っぱって入れる）
    for (const l of new Set(chains.flat())) members[l] = [...(members[l] ?? []), m];
    // 回る順（開始時刻を入れる最初のハウスと、終わった時刻を次へ送る順）は、矢印でつながった1本だけ（矢印のある方を優先）
    routes[m] = chains.find((c) => c.length > 1) ?? chains[0];
  }
  // 配置表の名前の順を保つ
  for (const l of Object.keys(members)) {
    const first = listed(l);
    members[l].sort((a, b) => (first.includes(a) ? first.indexOf(a) : 99) - (first.includes(b) ? first.indexOf(b) : 99));
  }
  return { members, routes };
}

/** 時刻の入力を分にする。「710」「7:10」「7.10」→ 7:10、「6」→ 6:00。空なら null、読めなければ undefined */
export function parseClock(s: string): number | null | undefined {
  const t = s.trim().replace("：", ":").replace(/[．.]/, ":");
  if (t === "") return null;
  const sep = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  let h: number, m: number;
  if (sep) [h, m] = [Number(sep[1]), Number(sep[2])];
  else if (/^\d{1,4}$/.test(t)) [h, m] = t.length <= 2 ? [Number(t), 0] : [Math.floor(Number(t) / 100), Number(t) % 100];
  else return undefined;
  return h < 24 && m < 60 ? h * 60 + m : undefined;
}
export const clock = (min: number | null | undefined) => (min == null ? "" : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`);

/** ケースの枚数（0.1枚単位）。空なら null、読めなければ undefined */
export function parseCases(s: string): number | null | undefined {
  const t = s.trim().replace("．", ".");
  if (t === "") return null;
  if (!/^\d{1,3}(\.\d)?$/.test(t)) return undefined;
  return Math.round(Number(t) * 10) / 10;
}

/** 1ケースあたりの時間（分）を「12分30秒」の形に */
export const perCaseText = (min: number | null) => {
  if (min == null || !Number.isFinite(min)) return "";
  const s = Math.round(min * 60);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
};
/** ケースの数を小数1けたに（＋1を重ねたときの小さなずれを消す） */
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const fmtCases = (n: number) => round1(n).toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** その行の時間（分）。入った・終わったの両方があるときだけ */
/** その日の休憩（start＝始まる時刻の分、minutes＝長さ）。収穫の時間から抜く */
export type HarvestBreak = { start: number; minutes: number };
/** ふだんの休憩：9:00から15分 */
export const DEFAULT_BREAK: HarvestBreak = { start: 540, minutes: 15 };
/** 時間 a〜b と休憩の重なり（分） */
export const breakOverlap = (a: number, b: number, brk: HarvestBreak) => Math.max(0, Math.min(b, brk.start + brk.minutes) - Math.max(a, brk.start));
/** そのハウスの収穫の時間（分）。入った・終わったの両方があるときだけ。休憩の時間は抜く */
export const houseMinutes = (h: HouseHarvest, brk: HarvestBreak = DEFAULT_BREAK) =>
  h.start != null && h.end != null && h.end > h.start ? h.end - h.start - breakOverlap(h.start, h.end, brk) : null;
/** 1人だけで収穫したハウスの、1ケースあたりの分（計算できなければ null） */
export const solePerCase = (h: HouseHarvest, brk: HarvestBreak = DEFAULT_BREAK) => {
  const m = houseMinutes(h, brk);
  return (h.members?.length ?? 0) === 1 && m != null && h.cases ? m / h.cases : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readDoc(v: unknown): HarvestDoc {
  return v && typeof v === "object" ? (v as HarvestDoc) : {};
}

/** その日の収穫の記録（読み込み中は undefined、まだなければ空） */
export type HarvestDay = {
  houses: HarvestDoc;
  endTime: number | null;
  forecast: number | null;
  /** 保存した休憩（なければ null＝ふだんの休憩） */ brk: HarvestBreak | null;
  /** 朝の予測（ハウスごとの入る・終わる予測） */
  forecastHouses: ForecastHouses | null;
};
/** ハウス → 朝の予測（入る・終わる。分） */
export type ForecastHouses = Record<string, { start: number | null; end: number; members?: string[] }>;
export const readForecastHouses = (v: unknown): ForecastHouses | null => (v && typeof v === "object" ? (v as ForecastHouses) : null);
/** 保存してある休憩を読む */
export const readBreak = (v: unknown): HarvestBreak | null =>
  v && typeof v === "object" && typeof (v as HarvestBreak).start === "number" && typeof (v as HarvestBreak).minutes === "number" ? (v as HarvestBreak) : null;
export function useHarvestDay(date: string): HarvestDay | undefined {
  const [state, setState] = useState<{ date: string; v: HarvestDay } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "harvest", date),
        (s) =>
          setState({
            date,
            v: {
              houses: readDoc(s.get("houses")),
              endTime: typeof s.get("endTime") === "number" ? (s.get("endTime") as number) : null,
              forecast: typeof s.get("forecast") === "number" ? (s.get("forecast") as number) : null,
              brk: readBreak(s.get("break")),
              forecastHouses: readForecastHouses(s.get("forecastHouses")),
            },
          }),
        () => setState({ date, v: { houses: {}, endTime: null, forecast: null, brk: null, forecastHouses: null } }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date]);
  return state && state.date === date ? state.v : undefined;
}

/** その日の収穫が終わった時刻（分。null＝消す） */
export async function saveHarvestEnd(date: string, endTime: number | null) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { endTime, updatedAt: serverTimestamp() }, { merge: true });
}

/** その日の休憩を保存する */
export async function saveHarvestBreak(date: string, brk: HarvestBreak) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { break: brk, updatedAt: serverTimestamp() }, { merge: true });
}

/** 1つのハウスの記録を直す（ほかのハウスはそのまま） */
export async function saveHouseHarvest(date: string, house: string, patch: HouseHarvest) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { houses: { [house]: patch }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 確定数を足す（＋1・−1）。ほかの端末で同時に押しても数えもれしない */
export async function addCases(date: string, house: string, delta: number, extra: HouseHarvest = {}) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  const patch: Record<string, unknown> = { ...extra, cases: increment(delta) };
  await setDoc(doc(db, "harvest", date), { houses: { [house]: patch }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 期間の収穫の記録（管理者だけ）。日付 → ハウス → 記録 */
export function useHarvestRange(from: string, to: string): Record<string, HarvestDoc> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; v: Record<string, HarvestDoc> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "harvest"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) => setState({ key, v: Object.fromEntries(snap.docs.map((d) => [d.id, readDoc(d.get("houses"))])) }),
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

/** 90日前の日付（前の日の状態をさがす範囲） */
const back90 = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 90 * 86400e3).toISOString().slice(0, 10);

/** ハウスの使い方：ハウスの名前 → 使い方 */
export type HouseUseMap = Record<string, HouseUse>;

/** その日のハウスの使い方。その日の記録がなければ、前の日（いちばん近い記録）の状態を引きつぐ */
export function useHouseUse(date: string): { houses: HouseUseMap; from: string | null } | undefined {
  const [state, setState] = useState<{ date: string; v: { houses: HouseUseMap; from: string | null } } | null>(null);
  useEffect(() => {
    let unsubs: (() => void)[] = [];
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      let own: HouseUseMap | null | undefined;
      let prev: { date: string; houses: HouseUseMap } | null | undefined;
      const emit = () => {
        if (own === undefined) return;
        if (own) return setState({ date, v: { houses: own, from: date } });
        if (prev === undefined) return;
        setState({ date, v: { houses: prev?.houses ?? {}, from: prev?.date ?? null } });
      };
      unsubs = [
        onSnapshot(
          doc(db, "houseUse", date),
          (s) => {
            own = s.exists() ? ((s.get("houses") as HouseUseMap) ?? {}) : null;
            emit();
          },
          () => {
            own = null;
            emit();
          },
        ),
        onSnapshot(
          // 前の日のいちばん近い記録（さかのぼって90日まで。日付の新しい順に読む方法は使えないので、まとめて読んで最後を使う）
          query(collection(db, "houseUse"), where(documentId(), ">=", back90(date)), where(documentId(), "<", date)),
          (snap) => {
            const d = snap.docs[snap.docs.length - 1];
            prev = d ? { date: d.id, houses: (d.get("houses") as HouseUseMap) ?? {} } : null;
            emit();
          },
          () => {
            prev = null;
            emit();
          },
        ),
      ];
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [date]);
  return state && state.date === date ? state.v : undefined;
}

export async function saveHouseUse(date: string, houses: HouseUseMap) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  await setDoc(doc(db, "houseUse", date), { houses, updatedAt: serverTimestamp() });
}

/** 期間のハウスの使い方（日付 → 使い方）と、期間の前のいちばん近い記録（はじめの日の状態に使う） */
export function useHouseUseRange(from: string, to: string): { days: Record<string, HouseUseMap>; before: HouseUseMap } | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; days?: Record<string, HouseUseMap>; before?: HouseUseMap } | null>(null);
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubs.push(
        onSnapshot(
          query(collection(db, "houseUse"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
          (snap) =>
            setState((s) => ({
              ...(s?.key === key ? s : {}),
              key,
              days: Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("houses") as HouseUseMap) ?? {}])),
            })),
          () => setState((s) => ({ ...(s?.key === key ? s : {}), key, days: {} })),
        ),
        onSnapshot(
          query(collection(db, "houseUse"), where(documentId(), ">=", back90(from)), where(documentId(), "<", from)),
          (snap) => setState((s) => ({ ...(s?.key === key ? s : {}), key, before: (snap.docs[snap.docs.length - 1]?.get("houses") as HouseUseMap) ?? {} })),
          () => setState((s) => ({ ...(s?.key === key ? s : {}), key, before: {} })),
        ),
      );
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [from, to, key]);
  return state && state.key === key && state.days && state.before ? { days: state.days, before: state.before } : null;
}

/** ハウスのまとまり（なければ、はじめの形） */
/** 収穫の開始時刻（分）のはじめの値：6:00 */
export const DEFAULT_START = 360;

export function useHouseGroups(): HouseGroup[] | null {
  return useHarvestConfig()?.groups ?? null;
}

/** 収穫の設定：ハウスのまとまりと、収穫の開始時刻（最初のハウスの「入った」に入れる） */
export type HarvestConfig = { groups: HouseGroup[]; startTime: number; plants: Record<string, number> };
export function useHarvestConfig(): HarvestConfig | null {
  const [v, setV] = useState<HarvestConfig | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/harvest"),
        (s) =>
          setV({
            groups: Array.isArray(s.get("groups")) ? (s.get("groups") as HouseGroup[]) : DEFAULT_GROUPS,
            startTime: typeof s.get("startTime") === "number" ? (s.get("startTime") as number) : DEFAULT_START,
            plants: s.get("plants") && typeof s.get("plants") === "object" ? (s.get("plants") as Record<string, number>) : DEFAULT_PLANTS,
          }),
        () => setV({ groups: DEFAULT_GROUPS, startTime: DEFAULT_START, plants: DEFAULT_PLANTS }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

export async function saveHouseGroups(groups: HouseGroup[]) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/harvest"), { groups, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveHarvestPlants(plants: Record<string, number>) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/harvest"), { plants, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveHarvestStart(startTime: number) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/harvest"), { startTime, updatedAt: serverTimestamp() }, { merge: true });
}

/** ハウスがどのまとまりに入るか（入っていなければ「その他」） */
export const groupOf = (groups: HouseGroup[], house: string) => groups.find((g) => g.houses.includes(house))?.name ?? "その他";

/** 集計：全部のケース、1人だけで収穫した分の時間とケース（1ケースあたりの時間に使う）、収穫した日、応援・共同のハウスの数 */
export type Tally = { cases: number; minutes: number; timedCases: number; days: Set<string>; shared: number };
export const emptyTally = (): Tally => ({ cases: 0, minutes: 0, timedCases: 0, days: new Set(), shared: 0 });
/** 記録を足す。cases は足すケース数（人別で共同のハウスを数えないときは 0 を渡す） */
export function addHouse(t: Tally, h: HouseHarvest, date: string, cases = h.cases ?? 0, brk: HarvestBreak = DEFAULT_BREAK) {
  t.cases += cases;
  t.days.add(date);
  if ((h.members?.length ?? 0) > 1) t.shared += 1;
  const m = houseMinutes(h, brk);
  if ((h.members?.length ?? 0) === 1 && m != null && h.cases) {
    t.minutes += m;
    t.timedCases += h.cases;
  }
}
/** 1ケースあたりの分（計算できなければ null） */
export const perCase = (t: Tally) => (t.timedCases > 0 ? t.minutes / t.timedCases : null);
