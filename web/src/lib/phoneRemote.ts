"use client";

// 収穫報告の携帯を、収穫管理から見る・操作する（「入った」「終わった」以外）。
// ・声の設定（harvestPhones/{従業員の id}）：携帯は、使える声の一覧と、いま使っている声・音と声の順番を入れる（local〜）。
//   収穫管理で変えると want〜 に入り、携帯が受けとって自分の設定にする（その携帯の中にも覚える）
// ・指示（harvest/{日付}/commands/{id}）：音声案内のテスト、行き先（ほかのハウスに行く）。携帯が受けとって実行し、doneAt を入れる
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { useEffect, useState } from "react";
import type { VoiceOrder } from "./announce";
import { getFirebase } from "./firebase";

const millis = (v: unknown) => (v as { toMillis?: () => number } | null)?.toMillis?.() ?? null;

export type PhoneState = {
  /** その携帯で使える日本語の声 */
  voices: string[];
  ios: boolean;
  /** その携帯でいま使っている声（null＝おまかせ）と、音と声の順番 */
  localVoice: string | null;
  localOrder: VoiceOrder | null;
  /** 収穫管理で決めた声・順番（携帯が受けとる） */
  wantVoice: string | null;
  wantOrder: VoiceOrder | null;
  wantAt: number | null;
  /** 「ほかのハウスに行く」で選んでいる行き先（その日だけ） */
  chosen: { date: string; house: string; by: "self" | "admin" } | null;
  /** 携帯が最後に知らせた時刻 */
  seenAt: number | null;
};

const phoneDoc = async (memberId: string) => doc((await getFirebase()).db, "harvestPhones", memberId);

/** その人の携帯の設定（読み込み中は undefined、まだなければ null） */
export function usePhoneState(memberId: string | null): PhoneState | null | undefined {
  const [state, setState] = useState<{ id: string; v: PhoneState | null } | null>(null);
  useEffect(() => {
    if (!memberId) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "harvestPhones", memberId),
        (s) =>
          setState({
            id: memberId,
            v: s.exists()
              ? {
                  voices: (s.get("voices") as string[]) ?? [],
                  ios: s.get("ios") === true,
                  localVoice: (s.get("localVoice") as string | null) ?? null,
                  localOrder: (s.get("localOrder") as VoiceOrder | null) ?? null,
                  wantVoice: (s.get("wantVoice") as string | null) ?? null,
                  wantOrder: (s.get("wantOrder") as VoiceOrder | null) ?? null,
                  wantAt: millis(s.get("wantAt")),
                  chosen: (s.get("chosen") as PhoneState["chosen"]) ?? null,
                  seenAt: millis(s.get("seenAt")),
                }
              : null,
          }),
        () => setState({ id: memberId, v: null }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [memberId]);
  return memberId && state?.id === memberId ? state.v : undefined;
}

/** 携帯が、使える声といま使っている設定を知らせる */
export async function reportPhone(memberId: string, p: { voices: string[]; ios: boolean; localVoice: string | null; localOrder: VoiceOrder }) {
  await setDoc(await phoneDoc(memberId), { ...p, seenAt: serverTimestamp() }, { merge: true });
}

/** 携帯が、「ほかのハウスに行く」で選んだ行き先を知らせる（null＝選んでいない） */
export async function reportChosen(memberId: string, chosen: PhoneState["chosen"]) {
  await setDoc(await phoneDoc(memberId), { chosen }, { merge: true });
}

/** 収穫管理から、その人の携帯の声・順番を変える */
export async function setPhonePrefs(memberId: string, voice: string | null, order: VoiceOrder) {
  await setDoc(await phoneDoc(memberId), { wantVoice: voice, wantOrder: order, wantAt: serverTimestamp() }, { merge: true });
}

// ---------- 指示 ----------

export type PhoneCommand = { id: string; to: string; kind: "test" | "goto"; house: string | null; at: number | null };

/** 収穫管理から、その人の携帯へ指示を送る */
export async function sendCommand(date: string, to: string, kind: PhoneCommand["kind"], house: string | null = null) {
  const { db, auth } = await getFirebase();
  const batch = writeBatch(db);
  batch.set(doc(collection(db, "harvest", date, "commands")), { to, kind, house, at: serverTimestamp(), by: auth.currentUser?.uid ?? "", doneAt: null });
  await batch.commit();
}

/** 自分あての、まだ実行していない指示（携帯） */
export function useMyCommands(date: string, memberId: string | null, enabled = true): PhoneCommand[] {
  const [v, setV] = useState<PhoneCommand[]>([]);
  useEffect(() => {
    if (!enabled || !memberId) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "harvest", date, "commands"), where("to", "==", memberId)),
        (snap) =>
          setV(
            snap.docs
              .filter((d) => d.get("doneAt") == null)
              .map((d) => ({
                id: d.id,
                to: memberId,
                kind: d.get("kind") as PhoneCommand["kind"],
                house: (d.get("house") as string | null) ?? null,
                at: millis(d.get("at")),
              }))
              .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
          ),
        () => setV([]),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [date, memberId, enabled]);
  return v;
}

/** 指示を実行した */
export async function doneCommand(date: string, id: string) {
  const { db } = await getFirebase();
  await updateDoc(doc(db, "harvest", date, "commands", id), { doneAt: serverTimestamp() });
}
