"use client";

// ハウスの中の温度（Govee の温湿度計）。サーバーが夜のあいだ20分ごとに読んで houseTemp/{その夜が明けた日} に残す。
// API キーはサーバーだけが持つ（画面からは登録するだけで、読み出せない）。見られるのは管理者だけ
import { collection, doc, documentId, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";

export type GoveeDevice = { device: string; sku: string; name: string };
export type GoveeConfig = { devices: GoveeDevice[]; houseOf: Record<string, string>; keySet: boolean };
/** ハウス → その夜の温度（t＝"HH:MM"、temp＝℃） */
export type HouseTempNight = Record<string, { t: string; temp: number }[]>;

export function useGoveeConfig(): GoveeConfig | null | undefined {
  const [v, setV] = useState<GoveeConfig | null | undefined>(undefined);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/govee"),
        (s) => setV(s.exists() ? { devices: s.get("devices") ?? [], houseOf: s.get("houseOf") ?? {}, keySet: s.get("keySet") === true } : null),
        () => setV(null),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

/** どの温度計がどのハウスか（温度計 → ハウス。空＝使わない） */
export async function saveGoveeHouses(houseOf: Record<string, string>) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/govee"), { houseOf, updatedAt: serverTimestamp() }, { merge: true });
}

/** API キーを登録して、温度計の一覧と今の温度を受け取る（キーを空で送ると、登録してあるキーで確かめ直す） */
export const saveGoveeKey = (apiKey: string) =>
  callFunction<{ apiKey: string }, { devices: GoveeDevice[]; now: Record<string, number | null> }>("saveGoveeKey", { apiKey }, 60_000);
/** 今すぐ1回読んで残す（つながっているかの確認） */
export const pollGoveeNow = () => callFunction<Record<string, never>, { saved: number; date?: string }>("pollGoveeNow", {}, 60_000);

/** 期間の、ハウスの中の夜の温度（日付 → ハウス → 読んだ値） */
export function useHouseTemps(from: string, to: string): Record<string, HouseTempNight> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; v: Record<string, HouseTempNight> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "houseTemp"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) => setState({ key, v: Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("readings") as HouseTempNight) ?? {}])) }),
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

/** その夜でいちばん低い温度と時刻（"前日23:00" のように、前の日の夜なら「前日」を付ける） */
export function nightLow(list: { t: string; temp: number }[] | undefined): { temp: number; at: string } | null {
  let best: { temp: number; at: string } | null = null;
  for (const x of list ?? []) if (best == null || x.temp < best.temp) best = { temp: x.temp, at: x.t >= "12:00" ? `前日${x.t}` : x.t };
  return best;
}
