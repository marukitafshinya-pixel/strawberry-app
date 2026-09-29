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

/**
 * タイルごとのマスの番号を決める。保存した番号を使い、ないタイル（新しく増えたメニューなど）や
 * 重なったタイルは、空いている後ろのマスに置く。
 */
export function assignMenuSlots(keys: string[], saved?: Record<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Set<number>();
  const rest: string[] = [];
  for (const k of keys) {
    const s = saved?.[k];
    if (typeof s === "number" && Number.isInteger(s) && s >= 0 && s < 200 && !used.has(s)) {
      result.set(k, s);
      used.add(s);
    } else rest.push(k);
  }
  for (const k of rest) {
    let s = used.size === 0 ? 0 : Math.max(...used) + 1;
    // 保存がないときは、上から順に詰めて並べる
    if (!saved) s = 0;
    while (used.has(s)) s++;
    result.set(k, s);
    used.add(s);
  }
  return result;
}
