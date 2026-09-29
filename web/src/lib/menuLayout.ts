"use client";

// メニューのタイルの配置（どの端末でも同じ）。config/menu に保存し、変えられるのは管理者だけ
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export type MenuLayout = {
  /** タイルのキー → マスの番号（0から。左上から右へ数える）。空いたマスも作れる */
  slots: Record<string, number>;
  /** 横に並べるマスの数 */
  cols: number;
};

export const MENU_COLS = [2, 3, 4, 5, 6];

export function useMenuLayout(): MenuLayout | null | undefined {
  // undefined＝読み込み中、null＝まだ保存されていない
  const [v, setV] = useState<MenuLayout | null | undefined>(undefined);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "config/menu"),
        (s) => {
          if (!s.exists()) return setV(null);
          const cols = s.get("cols");
          const slots = s.get("slots");
          setV({
            cols: MENU_COLS.includes(cols) ? cols : 3,
            slots: slots && typeof slots === "object" ? (Object.fromEntries(Object.entries(slots).filter(([, n]) => Number.isInteger(n))) as Record<string, number>) : {},
          });
        },
        () => setV(null),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return v;
}

export async function saveMenuLayout(l: MenuLayout) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/menu"), { slots: l.slots, cols: l.cols, updatedAt: serverTimestamp() });
}

/** 横幅（マスの数）を考えた置き場所：右にはみ出すときは左へずらす */
export function fitSlot(slot: number, w: number, cols: number): number {
  const over = (slot % cols) + w - cols;
  return over > 0 ? slot - over : slot;
}
/** そのタイルが使うマスの番号 */
export const cellsOf = (slot: number, w: number) => Array.from({ length: w }, (_, i) => slot + i);

/**
 * タイルごとのマスの番号を決める。保存した番号を使い、ないタイル（新しく増えたメニューなど）や
 * 重なったタイルは、空いている後ろのマスに置く。大きいタイル（横2マス）は隣のマスも使う。
 */
export function assignMenuSlots(keys: string[], saved: Record<string, number> | undefined, cols: number, widthOf: (k: string) => number): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Set<number>();
  const fits = (s: number, w: number) => (s % cols) + w <= cols && cellsOf(s, w).every((c) => !used.has(c));
  const take = (k: string, s: number, w: number) => {
    result.set(k, s);
    for (const c of cellsOf(s, w)) used.add(c);
  };
  const rest: string[] = [];
  for (const k of keys) {
    const w = Math.min(widthOf(k), cols);
    const raw = saved?.[k];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 200) {
      const s = fitSlot(raw, w, cols);
      if (fits(s, w)) {
        take(k, s, w);
        continue;
      }
    }
    rest.push(k);
  }
  for (const k of rest) {
    const w = Math.min(widthOf(k), cols);
    // 保存がないときは、上から順に詰めて並べる
    let s = !saved || used.size === 0 ? 0 : Math.max(...used) + 1;
    while (!fits(s, w)) s++;
    take(k, s, w);
  }
  return result;
}
