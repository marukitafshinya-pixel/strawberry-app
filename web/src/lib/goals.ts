"use client";

// 目標と実績（管理者だけ）：いちご金額（店舗・外販・出荷）、人件費、ホーブへの支払いの、月ごとの目標を決めて実績と比べる。
// 目標と、ホーブへの支払いの実績は手で入れる（goals/{年}）。ほかの実績はアプリのデータから出す。
import { collection, doc, documentId, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { computeRow, type Payroll } from "./payroll";

export const GOAL_ITEMS = [
  { key: "store", label: "店舗（外販を除く）", group: "ichigo" },
  { key: "gaihan", label: "外販", group: "ichigo" },
  { key: "ship", label: "出荷", group: "ichigo" },
  { key: "labor", label: "人件費", group: "cost" },
  { key: "hobe", label: "ホーブへの支払い", group: "cost" },
] as const;
export type GoalKey = (typeof GOAL_ITEMS)[number]["key"];
/** 月（"01"〜"12"）→ 項目 → 金額 */
export type GoalMonths = Record<string, Partial<Record<GoalKey, number>>>;
/** 手で入れる実績（ホーブへの支払い）：月 → 金額 */
export type HobeMonths = Record<string, number>;

export function useGoals(year: number) {
  const [state, setState] = useState<{ year: number; targets: GoalMonths; hobe: HobeMonths } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, `goals/${year}`),
        (s) => setState({ year, targets: (s.get("targets") as GoalMonths | undefined) ?? {}, hobe: (s.get("hobe") as HobeMonths | undefined) ?? {} }),
        () => setState({ year, targets: {}, hobe: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [year]);
  return state && state.year === year ? state : null;
}

const int = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n !== 0 ? Math.round(n) : undefined);

export async function saveGoals(year: number, targets: GoalMonths, hobe: HobeMonths) {
  const { db } = await getFirebase();
  const t: GoalMonths = {};
  for (const [m, v] of Object.entries(targets)) {
    const row: Partial<Record<GoalKey, number>> = {};
    for (const it of GOAL_ITEMS) {
      const n = int(v[it.key]);
      if (n !== undefined) row[it.key] = n;
    }
    if (Object.keys(row).length) t[m] = row;
  }
  const h: HobeMonths = {};
  for (const [m, v] of Object.entries(hobe)) {
    const n = int(v);
    if (n !== undefined) h[m] = n;
  }
  await setDoc(doc(db, `goals/${year}`), { targets: t, hobe: h, updatedAt: serverTimestamp() });
}

/** その年の月ごとの人件費（給与の「会社の負担」＝総支給＋事業所負担）。給与を打ち込んでいない月は入らない。月（"01"〜"12"）→ 金額 */
export function useLaborCost(year: number) {
  const [state, setState] = useState<{ year: number; data: Record<string, number> } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        query(collection(db, "payrolls"), where(documentId(), ">=", `${year}-01`), where(documentId(), "<=", `${year}-12`)),
        (snap) => {
          const data: Record<string, number> = {};
          for (const d of snap.docs) {
            const p = d.data() as Partial<Payroll>;
            const pay = Object.values(p.rows ?? {}).reduce((n, r) => n + computeRow(r).pay, 0);
            const employer = Object.values(p.employer ?? {}).reduce((n, v) => n + (v ?? 0), 0);
            if (pay + employer) data[d.id.slice(5, 7)] = pay + employer;
          }
          setState({ year, data });
        },
        () => setState({ year, data: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [year]);
  return state && state.year === year ? state.data : null;
}
