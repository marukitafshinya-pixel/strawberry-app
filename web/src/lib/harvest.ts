"use client";

// 収穫管理（棟別出荷調査票）：ハウスごとに、その日の収穫者・入った時刻・終わった時刻・確定数（ケース）を記録する（harvest/{YYYY-MM-DD}）。
// ケースは集荷のたびに「＋1」を押して数え、押すたびにすぐ保存する（どの端末でも同じ数になる）。
// その日のハウスの使い方（収穫・いちご狩り・半分・予備・休み）は houseUse/{YYYY-MM-DD}。記録がない日は前の日の状態を引きつぐ。
// 1ケースあたりの時間は、1人だけで収穫したハウスで計算する（途中で応援が入ったハウスは、ケース数だけ数える）。実績は管理者だけが見られる。
import { collection, doc, documentId, increment, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { sectionArrows, type HaichiDay, type HaichiTemplate } from "./haichi";

/** 1つのハウスのその日の記録。start・end は0時からの分、cases は確定数（0.1枚単位） */
export type HouseHarvest = { members?: string[]; start?: number | null; end?: number | null; cases?: number };
/** ハウスの名前 → 記録 */
export type HarvestDoc = Record<string, HouseHarvest>;

export type HouseUse = "harvest" | "picking" | "half" | "reserve" | "off";
export const HOUSE_USES: { key: HouseUse; label: string; short: string; cls: string }[] = [
  { key: "harvest", label: "収穫", short: "収", cls: "bg-rose-100 text-rose-900 border-rose-300" },
  { key: "picking", label: "いちご狩り", short: "狩", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  { key: "half", label: "半分（前いちご狩り・後ろ収穫）", short: "半", cls: "bg-gradient-to-r from-emerald-100 to-rose-100 text-gray-900 border-amber-300" },
  { key: "reserve", label: "予備（収穫を止めている）", short: "予", cls: "bg-yellow-100 text-yellow-900 border-yellow-300" },
  { key: "off", label: "休み", short: "－", cls: "bg-gray-100 text-gray-500 border-gray-300" },
];
export const houseUseOf = (k: string | undefined) => HOUSE_USES.find((u) => u.key === k) ?? HOUSE_USES[0];

/** ハウスのまとまり（集計で使う）。houses はハウスの名前（作業配置表の枠の名前と同じ） */
export type HouseGroup = { name: string; houses: string[] };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
export const DEFAULT_GROUPS: HouseGroup[] = [
  { name: "1・6・8", houses: ["1", "6", "8"] },
  { name: "17〜20", houses: range(17, 20) },
  { name: "21〜27", houses: range(21, 27) },
];

/** 作業配置表の収穫の枠から、ハウスの名前を並べる */
export function harvestHouses(t: HaichiTemplate): string[] {
  const out: string[] = [];
  for (const s of t.sections) if (sectionArrows(s)) for (const sl of s.slots) if (!out.includes(sl.label)) out.push(sl.label);
  return out;
}

/** その日の作業配置表で、ハウスに割り振られた人（収穫の枠） */
export function haichiMembers(t: HaichiTemplate, day: HaichiDay): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of t.sections) if (sectionArrows(s)) for (const sl of s.slots) if (day.cells[sl.id]?.members.length) out[sl.label] = day.cells[sl.id].members;
  return out;
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
export const houseMinutes = (h: HouseHarvest) => (h.start != null && h.end != null && h.end > h.start ? h.end - h.start : null);
/** 1人だけで収穫したハウスの、1ケースあたりの分（計算できなければ null） */
export const solePerCase = (h: HouseHarvest) => {
  const m = houseMinutes(h);
  return (h.members?.length ?? 0) === 1 && m != null && h.cases ? m / h.cases : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readDoc(v: unknown): HarvestDoc {
  return v && typeof v === "object" ? (v as HarvestDoc) : {};
}

/** その日の収穫の記録（読み込み中は undefined、まだなければ空） */
export function useHarvestDay(date: string): HarvestDoc | undefined {
  const [state, setState] = useState<{ date: string; v: HarvestDoc } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "harvest", date),
        (s) => setState({ date, v: readDoc(s.get("houses")) }),
        () => setState({ date, v: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date]);
  return state && state.date === date ? state.v : undefined;
}

/** 1つのハウスの記録を直す（ほかのハウスはそのまま） */
export async function saveHouseHarvest(date: string, house: string, patch: HouseHarvest) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { houses: { [house]: patch }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 確定数を足す（＋1・−1）。ほかの端末で同時に押しても数えもれしない */
export async function addCases(date: string, house: string, delta: number, members?: string[]) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  const patch: Record<string, unknown> = { cases: increment(delta) };
  if (members) patch.members = members;
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
          query(collection(db, "houseUse"), where(documentId(), "<", date), orderBy(documentId(), "desc"), limit(1)),
          (snap) => {
            const d = snap.docs[0];
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
          query(collection(db, "houseUse"), where(documentId(), "<", from), orderBy(documentId(), "desc"), limit(1)),
          (snap) => setState((s) => ({ ...(s?.key === key ? s : {}), key, before: (snap.docs[0]?.get("houses") as HouseUseMap) ?? {} })),
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
export function useHouseGroups(): HouseGroup[] | null {
  const [v, setV] = useState<HouseGroup[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/harvest"),
        (s) => setV(s.exists() && Array.isArray(s.get("groups")) ? (s.get("groups") as HouseGroup[]) : DEFAULT_GROUPS),
        () => setV(DEFAULT_GROUPS),
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
  await setDoc(doc(db, "config/harvest"), { groups, updatedAt: serverTimestamp() });
}

/** ハウスがどのまとまりに入るか（入っていなければ「その他」） */
export const groupOf = (groups: HouseGroup[], house: string) => groups.find((g) => g.houses.includes(house))?.name ?? "その他";

/** 集計：全部のケース、1人だけで収穫した分の時間とケース（1ケースあたりの時間に使う）、収穫した日、応援・共同のハウスの数 */
export type Tally = { cases: number; minutes: number; timedCases: number; days: Set<string>; shared: number };
export const emptyTally = (): Tally => ({ cases: 0, minutes: 0, timedCases: 0, days: new Set(), shared: 0 });
/** 記録を足す。cases は足すケース数（人別で共同のハウスを数えないときは 0 を渡す） */
export function addHouse(t: Tally, h: HouseHarvest, date: string, cases = h.cases ?? 0) {
  t.cases += cases;
  t.days.add(date);
  if ((h.members?.length ?? 0) > 1) t.shared += 1;
  const m = houseMinutes(h);
  if ((h.members?.length ?? 0) === 1 && m != null && h.cases) {
    t.minutes += m;
    t.timedCases += h.cases;
  }
}
/** 1ケースあたりの分（計算できなければ null） */
export const perCase = (t: Tally) => (t.timedCases > 0 ? t.minutes / t.timedCases : null);
