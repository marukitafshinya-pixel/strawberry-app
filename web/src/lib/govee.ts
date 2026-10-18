"use client";

// ハウスの中の温度（Govee の温湿度計）。サーバーが1日じゅう20分ごとに読んで houseTemp/{日付} に残す。
// 1つの日付には「前の日の9時すぎ〜その日の9時」の24時間分が入る（その日の収穫の前の24時間）。
// API キーはサーバーだけが持つ（画面からは登録するだけで、読み出せない）。見られるのは管理者だけ
import { collection, doc, documentId, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";

export type GoveeDevice = { device: string; sku: string; name: string };
/** alertTemp＝温度の見張りで知らせる温度（℃。これより下がったら警報） */
export type GoveeConfig = { devices: GoveeDevice[]; houseOf: Record<string, string>; keySet: boolean; alertTemp: number };
export const DEFAULT_ALERT_TEMP = 4;
/** ハウス → その日の分の温度（t＝"HH:MM"、temp＝℃） */
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
        (s) =>
          setV(
            s.exists()
              ? {
                  devices: s.get("devices") ?? [],
                  houseOf: s.get("houseOf") ?? {},
                  keySet: s.get("keySet") === true,
                  alertTemp: typeof s.get("alertTemp") === "number" ? s.get("alertTemp") : DEFAULT_ALERT_TEMP,
                }
              : null,
          ),
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

/** 温度の見張りで知らせる温度を保存する */
export async function saveAlertTemp(alertTemp: number) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/govee"), { alertTemp, updatedAt: serverTimestamp() }, { merge: true });
}

/** 読んだ値の日本時間の時刻（ミリ秒）。date の分には「前の日の9時すぎ〜その日の9時」が入っている */
export function readingAt(date: string, t: string): number {
  const day = t > "09:00" ? new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10) : date;
  return Date.parse(`${day}T${t}:00+09:00`);
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

/** 読んだ時刻の表し方（9時すぎは前の日の分なので「前日」を付ける） */
const atOf = (t: string) => (t > "09:00" ? `前日${t}` : t);

/** いちばん低い温度と時刻（ふつうは夜） */
export function nightLow(list: { t: string; temp: number }[] | undefined): { temp: number; at: string } | null {
  return dayStats(list)?.min ?? null;
}

/** 1日（24時間）に読む回数（20分ごと） */
export const READS_PER_DAY = 72;

/** その日の分の最低・平均・最高（n＝読めた回数。少ない日は平均・最高があてにならない） */
export function dayStats(list: { t: string; temp: number }[] | undefined) {
  if (!list?.length) return null;
  let min = list[0];
  let max = list[0];
  let sum = 0;
  for (const x of list) {
    if (x.temp < min.temp) min = x;
    if (x.temp > max.temp) max = x;
    sum += x.temp;
  }
  return {
    min: { temp: min.temp, at: atOf(min.t) },
    max: { temp: max.temp, at: atOf(max.t) },
    avg: Math.round((sum / list.length) * 10) / 10,
    n: list.length,
  };
}

/**
 * そのハウスの温度に使う温度計のハウス：同じまとまりの中で、番号がいちばん近い温度計。
 * まとまりに温度計がない（またはその夜に読めていない）ときは、全体でいちばん近い温度計
 */
export function sensorFor(house: string, sensors: string[], groupOfHouse: (h: string) => string): string | null {
  if (sensors.includes(house)) return house;
  const near = (list: string[]) =>
    list.reduce<string | null>((best, s) => {
      const d = Math.abs(Number(s) - Number(house));
      return best == null || d < Math.abs(Number(best) - Number(house)) || (d === Math.abs(Number(best) - Number(house)) && Number(s) < Number(best))
        ? s
        : best;
    }, null);
  const g = groupOfHouse(house);
  return near(sensors.filter((s) => groupOfHouse(s) === g)) ?? near(sensors);
}

// ---------- 温度の見張り（担当①②③と、いま出ている警報） ----------

/** 見張り担当（従業員リストの id。①②③の順） */
export function useTempWatchers(): string[] | null {
  const [v, setV] = useState<string[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/tempWatch"),
        (s) => setV(Array.isArray(s.get("watchers")) ? (s.get("watchers") as string[]) : []),
        () => setV([]),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

export async function saveTempWatchers(watchers: string[]) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/tempWatch"), { watchers, updatedAt: serverTimestamp() });
}

export type TempAlertItem = { house: string; kind: "low" | "stale"; temp?: number; since: number };
/** いま出ている警報（サーバーが20分ごとに入れる）。時刻はミリ秒 */
export type TempAlert = {
  items: TempAlertItem[];
  startedAt: number | null;
  ackBy: string | null;
  ackAt: number | null;
  latest: Record<string, { temp: number; at: number }>;
  alertTemp: number;
  checkedAt: number | null;
};

/** undefined＝読み込み中、null＝まだない・読めない */
export function useTempAlert(): TempAlert | null | undefined {
  const [v, setV] = useState<TempAlert | null | undefined>(undefined);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "alerts/temp"),
        (s) => {
          if (!s.exists()) return setV(null);
          const ack = s.get("ackAt") as { toMillis?: () => number } | null;
          setV({
            items: (s.get("items") as TempAlertItem[]) ?? [],
            startedAt: s.get("startedAt") ?? null,
            ackBy: s.get("ackBy") ?? null,
            ackAt: ack?.toMillis ? ack.toMillis() : null,
            latest: s.get("latest") ?? {},
            alertTemp: typeof s.get("alertTemp") === "number" ? s.get("alertTemp") : DEFAULT_ALERT_TEMP,
            checkedAt: s.get("checkedAt") ?? null,
          });
        },
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

/** 「止める」：だれが止めたかを入れる（全員の音が止まる） */
export async function ackTempAlert(name: string) {
  const { db } = await getFirebase();
  await updateDoc(doc(db, "alerts/temp"), { ackBy: name.slice(0, 40), ackAt: serverTimestamp() });
}
