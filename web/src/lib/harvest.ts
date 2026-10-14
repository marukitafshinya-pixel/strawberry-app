"use client";

// 収穫管理：だれが、どのハウスに何時から何時まで入って、何ケース取ったか（harvest/{YYYY-MM-DD}）と、
// その日のハウスの使い方（収穫・いちご狩り・半分・予備・休み）（houseUse/{YYYY-MM-DD}）を記録する。
// 収穫の記録は、スタッフは最近の日だけ入力でき、集計（実績）は管理者だけが見られる。
// ハウスの一覧は、作業配置表の「収穫」の枠（矢印を付けるまとまり）と同じ。ハウスのまとまり（グループ）は config/harvest。
import { collection, doc, documentId, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { sectionArrows, type HaichiDay, type HaichiTemplate } from "./haichi";

/** 1行＝1人が1つのハウスに入った分。start・end は0時からの分、cases はケースの枚数（0.1枚単位） */
export type HarvestRow = { id: string; member: string; house: string; start: number | null; end: number | null; cases: number | null };

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

export const newRowId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** その日の作業配置表から、収穫の行を作る（人ごとに、配置表の枠の順） */
export function rowsFromHaichi(t: HaichiTemplate, day: HaichiDay): HarvestRow[] {
  const byMember = new Map<string, string[]>();
  for (const s of t.sections) {
    if (!sectionArrows(s)) continue;
    for (const sl of s.slots) for (const m of day.cells[sl.id]?.members ?? []) byMember.set(m, [...(byMember.get(m) ?? []), sl.label]);
  }
  return [...byMember].flatMap(([member, houses]) => houses.map((house) => ({ id: newRowId(), member, house, start: null, end: null, cases: null })));
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

/** その行の時間（分）。入った・終わったの両方があるときだけ */
export const rowMinutes = (r: HarvestRow) => (r.start != null && r.end != null && r.end > r.start ? r.end - r.start : null);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readRows(v: unknown): HarvestRow[] {
  return Array.isArray(v) ? (v as HarvestRow[]).filter((r) => r && typeof r.member === "string" && typeof r.house === "string") : [];
}

/** その日の収穫の記録（まだ保存していなければ null。読み込み中は undefined） */
export function useHarvestDay(date: string): HarvestRow[] | null | undefined {
  const [state, setState] = useState<{ date: string; v: HarvestRow[] | null } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "harvest", date),
        (s) => setState({ date, v: s.exists() ? readRows(s.get("rows")) : null }),
        () => setState({ date, v: null }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date]);
  return state && state.date === date ? state.v : undefined;
}

export async function saveHarvestDay(date: string, rows: HarvestRow[]) {
  if (!DATE_RE.test(date)) throw new Error("日付が正しくありません");
  const { db } = await getFirebase();
  // ハウスも人も決まっていない行は保存しない
  const clean = rows
    .filter((r) => r.member && r.house)
    .map((r) => ({ id: r.id, member: r.member, house: r.house, start: r.start, end: r.end, cases: r.cases }));
  await setDoc(doc(db, "harvest", date), { rows: clean, updatedAt: serverTimestamp() });
}

/** 期間の収穫の記録（管理者だけ）。日付 → 行 */
export function useHarvestRange(from: string, to: string): Record<string, HarvestRow[]> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; v: Record<string, HarvestRow[]> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "harvest"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) => setState({ key, v: Object.fromEntries(snap.docs.map((d) => [d.id, readRows(d.get("rows"))])) }),
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

/** 集計：ケース・時間（分）・1ケースあたりの分（時間とケースの両方がある行だけで計算） */
export type Tally = { cases: number; minutes: number; timedCases: number; days: Set<string> };
export const emptyTally = (): Tally => ({ cases: 0, minutes: 0, timedCases: 0, days: new Set() });
export function addRow(t: Tally, r: HarvestRow, date: string) {
  t.cases += r.cases ?? 0;
  t.days.add(date);
  const m = rowMinutes(r);
  if (m != null && r.cases) {
    t.minutes += m;
    t.timedCases += r.cases;
  }
}
/** 1ケースあたりの分（計算できなければ null） */
export const perCase = (t: Tally) => (t.timedCases > 0 ? t.minutes / t.timedCases : null);
export const fmtCases = (n: number) => (Math.round(n * 10) / 10).toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
