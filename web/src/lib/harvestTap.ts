"use client";

// 収穫報告：収穫する人が自分の携帯で「入った」「終わった」を押す（harvest/{日付}/taps/{従業員のid}）。
// 押した時刻は、収穫管理のハウスの「入った・終わった」にも入れる（収穫者は時刻だけ書ける。収穫管理のデータは読めない）。
// 1つのハウスに2人以上いるときは、入った＝最初に押した人の時刻、終わった＝全員が押した時刻（最後の人）
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
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
  // 携帯から入れた「入った」は startAuto（収穫管理の色：押した人だけを水色にする。ほかの人は本人が押すまで緑）
  const p = patch.start != null ? { ...patch, startAuto: true } : patch;
  await setDoc(doc(db, "harvest", date), { tapHouse: house, houses: { [house]: p }, updatedAt: serverTimestamp() }, { merge: true });
}

/** 応援で入った人の名前を、収穫管理のハウスに足す・外す（予定の人の名前はそのまま。自分の名前だけ） */
export async function setTapHelper(date: string, house: string, memberId: string, on: boolean) {
  const { db } = await getFirebase();
  await setDoc(
    doc(db, "harvest", date),
    { tapHouse: house, houses: { [house]: { helpers: on ? arrayUnion(memberId) : arrayRemove(memberId) } }, updatedAt: serverTimestamp() },
    { merge: true },
  );
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
  /** 応援が必要な順（いまのままだと終わるのがおそい順）：ハウス・終わる見込み（分）・いまの人数（向かっている人もふくむ）・もう入っているか */
  ranking?: { house: string; finish: number; crew: number; started: boolean }[];
  /** 🏁ここで終了のハウス */
  stops?: string[];
};
export const fetchHelpHouse = (free = false) => callFunction<{ free: boolean }, HelpInfo>("harvestHelpHouse", { free });

/** 休憩の合図を送る（収穫管理の画面から。収穫報告を開いている全員の携帯で鳴る） */
export async function callBreak(date: string) {
  const { db, auth } = await getFirebase();
  await setDoc(doc(db, "harvest", date, "calls", "break"), { at: serverTimestamp(), by: auth.currentUser?.uid ?? "" });
}

/** 休憩の合図が来たら onCall を呼ぶ（開いたときにもう出ていた合図では鳴らさない） */
export function useBreakCall(date: string, enabled: boolean, onCall: () => void) {
  useEffect(() => {
    if (!enabled) return;
    let unsub = () => {};
    let cancelled = false;
    let seen: number | null | undefined = undefined;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(doc(db, "harvest", date, "calls", "break"), (s) => {
        // サーバーの時刻が入るまで（押した人の画面では一瞬 null）は待つ
        const at = (s.get("at") as { toMillis?: () => number } | null)?.toMillis?.() ?? null;
        if (s.metadata.hasPendingWrites) return;
        if (seen === undefined) {
          seen = at;
          return;
        }
        if (at != null && at !== seen) {
          seen = at;
          onCall();
        }
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // onCall は毎回作り直されるので、日付と有効かどうかだけで登録し直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, enabled]);
}

// ---------- 個別の連絡（収穫管理から、選んだ人の携帯へ。音と声と画面で知らせる） ----------

/** 連絡（harvest/{日付}/messages/{id}）：to＝従業員の id、ackAt＝本人が「了解です」を押した時刻 */
export type HarvestMessage = { id: string; to: string; text: string; at: number | null; ackAt: number | null };
const millis = (v: unknown) => (v as { toMillis?: () => number } | null)?.toMillis?.() ?? null;

/** 連絡を送る（1人ずつ1通） */
export async function sendMessages(date: string, to: string[], text: string) {
  const { db, auth } = await getFirebase();
  const batch = writeBatch(db);
  for (const id of to)
    batch.set(doc(collection(db, "harvest", date, "messages")), { to: id, text, at: serverTimestamp(), by: auth.currentUser?.uid ?? "", ackAt: null });
  await batch.commit();
}

/** その日の連絡。memberId を渡すとその人あての分だけ（従業員は自分あての分しか読めない） */
export function useMessages(date: string, memberId: string | null, enabled = true): HarvestMessage[] | null {
  const [state, setState] = useState<{ key: string; v: HarvestMessage[] } | null>(null);
  const key = `${date}_${memberId ?? ""}`;
  useEffect(() => {
    if (!enabled) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      const col = collection(db, "harvest", date, "messages");
      unsub = onSnapshot(
        memberId ? query(col, where("to", "==", memberId)) : col,
        (snap) =>
          setState({
            key,
            v: snap.docs
              .map((d) => ({ id: d.id, to: String(d.get("to")), text: String(d.get("text") ?? ""), at: millis(d.get("at")), ackAt: millis(d.get("ackAt")) }))
              .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
          }),
        () => setState({ key, v: [] }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date, memberId, enabled, key]);
  return state?.key === key ? state.v : null;
}

/** 本人が「了解です」を押した（送った人の画面に「✓ 了解です」と出る） */
export async function ackMessage(date: string, id: string) {
  const { db } = await getFirebase();
  await updateDoc(doc(db, "harvest", date, "messages", id), { ackAt: serverTimestamp() });
}

/**
 * アプリを開いている印を、開いている間（画面が見えている間）30秒ごとに入れる（従業員の携帯）。
 * slow＝画面を黒くしている間（電池の節約）：2分ごと
 */
export function usePresence(date: string, memberId: string | null, enabled = true, slow = false) {
  useEffect(() => {
    if (!enabled || !memberId) return;
    let alive = true;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      getFirebase()
        .then(async ({ db }) => {
          if (alive) await setDoc(doc(db, "harvest", date, "presence", memberId), { at: serverTimestamp() });
        })
        .catch(() => {});
    };
    beat();
    const t = setInterval(beat, slow ? 120_000 : 30_000);
    document.addEventListener("visibilitychange", beat);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [date, memberId, enabled, slow]);
}

/** この時間（ミリ秒）より前の印しかなければ、アプリを開いていないとみなす（黒い画面の間は2分ごとなので、それより長く） */
export const PRESENCE_MS = 150_000;

/** みんなの、アプリを開いている印（従業員の id → 最後の時刻 ミリ秒）。送る人の画面で使う */
export function usePresenceAll(date: string, enabled = true): Record<string, number> | null {
  const [state, setState] = useState<{ date: string; v: Record<string, number> } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        collection(db, "harvest", date, "presence"),
        (snap) => setState({ date, v: Object.fromEntries(snap.docs.map((d) => [d.id, millis(d.get("at")) ?? 0])) }),
        () => setState({ date, v: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date, enabled]);
  return state?.date === date ? state.v : null;
}

/** 個別の連絡の定型文（はじめのもの。config/messagePresets がないとき） */
export const DEFAULT_MESSAGE_PRESETS = ["集荷場に来てください", "事務所に来てください", "電話に出てください", "休憩に入ってください"];

/** 個別の連絡の定型文（追加・編集したもの）。読み込み中は null */
export function useMessagePresets(): string[] | null {
  const [v, setV] = useState<string[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config", "messagePresets"),
        (s) => setV(Array.isArray(s.get("items")) ? (s.get("items") as string[]) : DEFAULT_MESSAGE_PRESETS),
        () => setV(DEFAULT_MESSAGE_PRESETS),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

export async function saveMessagePresets(items: string[]) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config", "messagePresets"), { items, updatedAt: serverTimestamp() });
}
