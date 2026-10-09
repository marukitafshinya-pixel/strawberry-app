"use client";

// 作業配置表：その日に出勤する人を、作業の枠（収穫のハウス・売り場の係など）に割り振る。
// 枠の並び（ひな形）は config/haichi に1件、日ごとの割り振りは haichi/{YYYY-MM-DD} に保存する。
// 1人が複数の枠に入ってもよい。枠ごとにメモ（「赤玉」「PM」など）を書ける。
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export type HaichiSlot = { id: string; label: string };
export type HaichiSection = { id: string; name: string; slots: HaichiSlot[] };
export type HaichiTemplate = { sections: HaichiSection[] };
/** その日の割り振り。cells は 枠のID → 入る人（従業員ID）とメモ */
export type HaichiCell = { members: string[]; memo: string };
export type HaichiDay = { cells: Record<string, HaichiCell>; note: string; done: boolean };

const sl = (id: string, label: string): HaichiSlot => ({ id, label });

/** はじめの枠（いままで使っていたExcelの配置表の形）。画面から変えられる */
export const DEFAULT_HAICHI: HaichiTemplate = {
  sections: [
    { id: "harvest", name: "収穫", slots: ["1", "6", "8", "4", "5", "9", "10"].map((n) => sl(`h${n}`, n)) },
    { id: "harvest2", name: "ハウス17〜27", slots: Array.from({ length: 11 }, (_, i) => sl(`h${17 + i}`, String(17 + i))) },
    { id: "pickup", name: "集荷", slots: [sl("pickup", "集荷係")] },
    { id: "shop", name: "売り場", slots: ["案内係", "受付・レジ", "選別", "製品チェック", "選別機"].map((l, i) => sl(`shop${i + 1}`, l)) },
    { id: "work", name: "作業", slots: ["四季彩の丘", "11-16ベンチ", "いちご手入れ", "NO20", "いちご防除"].map((l, i) => sl(`work${i + 1}`, l)) },
  ],
};

export const EMPTY_DAY: HaichiDay = { cells: {}, note: "", done: false };

export function useHaichiTemplate(): HaichiTemplate | null {
  const [v, setV] = useState<HaichiTemplate | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/haichi"),
        (snap) => setV(snap.exists() && Array.isArray(snap.get("sections")) ? { sections: snap.get("sections") as HaichiSection[] } : DEFAULT_HAICHI),
        () => setV(DEFAULT_HAICHI),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

export async function saveHaichiTemplate(t: HaichiTemplate) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/haichi"), { sections: t.sections, updatedAt: serverTimestamp() });
}

/** その日の割り振り（まだなければ空） */
export function useHaichiDay(date: string): HaichiDay | null {
  const [state, setState] = useState<{ date: string; v: HaichiDay } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "haichi", date),
        (snap) =>
          setState({
            date,
            v: snap.exists()
              ? { cells: (snap.get("cells") as Record<string, HaichiCell>) ?? {}, note: (snap.get("note") as string) ?? "", done: snap.get("done") === true }
              : EMPTY_DAY,
          }),
        () => setState({ date, v: EMPTY_DAY }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date]);
  return state && state.date === date ? state.v : null;
}

export async function saveHaichiDay(date: string, d: HaichiDay) {
  const { db } = await getFirebase();
  // 人もメモもない枠は保存しない
  const cells = Object.fromEntries(Object.entries(d.cells).filter(([, c]) => c.members.length > 0 || c.memo.trim()));
  await setDoc(doc(db, "haichi", date), { cells, note: d.note.slice(0, 200), done: d.done, updatedAt: serverTimestamp() });
}

/** 新しい枠のID */
export const newSlotId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
