"use client";

// トータル実績：出荷・店舗の実績に、ほかの売上（玉ねぎ・そば・作業委託＆冷蔵庫リース）を足して月ごとに集計する。
// ほかの売上は、月ごとの合計を手で入れる（otherSales/{年}）。
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export const OTHER_ITEMS = [
  { key: "onion", label: "玉ねぎ" },
  { key: "soba", label: "そば" },
  { key: "contract", label: "作業委託＆冷蔵庫リース" },
] as const;
export type OtherKey = (typeof OTHER_ITEMS)[number]["key"];
/** 月（"01"〜"12"）→ 項目 → 金額 */
export type OtherMonths = Record<string, Partial<Record<OtherKey, number>>>;

export function useOtherSales(year: number) {
  const [state, setState] = useState<{ year: number; months: OtherMonths } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, `otherSales/${year}`),
        (s) => setState({ year, months: (s.get("months") as OtherMonths | undefined) ?? {} }),
        () => setState({ year, months: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [year]);
  return state && state.year === year ? state.months : null;
}

export async function saveOtherSales(year: number, months: OtherMonths) {
  const { db } = await getFirebase();
  const clean: OtherMonths = {};
  for (const [m, v] of Object.entries(months)) {
    const row: Partial<Record<OtherKey, number>> = {};
    for (const it of OTHER_ITEMS) {
      const n = v[it.key];
      if (typeof n === "number" && Number.isFinite(n) && n !== 0) row[it.key] = Math.round(n);
    }
    if (Object.keys(row).length) clean[m] = row;
  }
  await setDoc(doc(db, `otherSales/${year}`), { months: clean, updatedAt: serverTimestamp() });
}
