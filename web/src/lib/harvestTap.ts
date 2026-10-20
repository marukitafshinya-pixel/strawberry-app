"use client";

// 収穫報告：収穫する人が自分の携帯で「入った」「終わった」を押す（harvest/{日付}/taps/{従業員のid}）。
// 押した時刻は、収穫管理のハウスの「入った・終わった」にも入れる（収穫者は時刻だけ書ける。収穫管理のデータは読めない）。
// 1つのハウスに2人以上いるときは、入った＝最初に押した人の時刻、終わった＝全員が押した時刻（最後の人）
import { collection, doc, getDocs, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";
import type { HouseUse } from "./harvest";

/** 1人の、ハウス → 押した時刻（0時からの分） */
export type MyTaps = Record<string, { start?: number | null; end?: number | null }>;
/** 従業員の id → その人の押した時刻 */
export type DayTaps = Record<string, MyTaps>;

/** 収穫しない使い方（収穫報告に出さない） */
export const NO_HARVEST: HouseUse[] = ["picking", "reserve", "off"];

/** 今日の、みんなの押した時刻 */
export function useDayTaps(date: string): DayTaps | null {
  const [state, setState] = useState<{ date: string; v: DayTaps } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        collection(db, "harvest", date, "taps"),
        (snap) => setState({ date, v: Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("houses") as MyTaps) ?? {}])) }),
        () => setState({ date, v: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date]);
  return state && state.date === date ? state.v : null;
}

/** いちばん新しい、みんなの押した時刻（終わったかを決める前に読み直す） */
export async function fetchDayTaps(date: string): Promise<DayTaps> {
  const { db } = await getFirebase();
  const snap = await getDocs(collection(db, "harvest", date, "taps"));
  return Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("houses") as MyTaps) ?? {}]));
}

/** 自分の押した時刻を残す */
export async function saveTap(date: string, memberId: string, house: string, patch: { start?: number | null; end?: number | null }) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date, "taps", memberId), { houses: { [house]: patch }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 収穫管理のハウスの「入った・終わった」に入れる（1つのハウスだけ） */
export async function saveTapToHouse(date: string, house: string, patch: { start?: number | null; end?: number | null }) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "harvest", date), { tapHouse: house, houses: { [house]: patch }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 今の日本時間（0時からの分） */
export function nowMinJST() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * サーバーに聞く：house＝自分の応援先（free＝自分の予定が終わったときに割り当ててもらう。終わっていないハウスへまんべんなく）、
 * assign＝みんなの応援先（従業員の id → ハウス）、open＝終わっていないハウスがあるか、forecast＝朝の予測があるか、
 * done＝もう終わったハウス、members＝集荷係が収穫管理で入れ直したハウスの収穫者（作業配置表より優先する）、
 * started＝収穫中のハウス（集荷係が入れた分もふくむ）
 */
export type HelpInfo = {
  house: string | null;
  assign: Record<string, string>;
  open: boolean;
  forecast: boolean;
  done: string[];
  members: Record<string, string[]>;
  /** 収穫中のハウス（収穫管理に「入った」があって「終わった」がまだ）→ 入った時刻と、終わる前にほかへ移った人 */
  started?: Record<string, { start: number; left: string[] }>;
};
export const fetchHelpHouse = (free = false) => callFunction<{ free: boolean }, HelpInfo>("harvestHelpHouse", { free });
