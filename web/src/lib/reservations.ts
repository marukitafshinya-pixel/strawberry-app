"use client";

import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { SETTINGS_DOC, normalizeSettings, type Settings } from "./settings";

/** request = 定員を超えたためのリクエスト（お店の承認待ち。定員には数えない） */
export type ReservationStatus = "request" | "tentative" | "confirmed" | "visited" | "cancelled";

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  request: "リクエスト",
  tentative: "予定",
  confirmed: "確定",
  visited: "来店済",
  cancelled: "キャンセル",
};

export const STATUS_STYLE: Record<ReservationStatus, string> = {
  request: "bg-purple-100 text-purple-800",
  tentative: "bg-amber-100 text-amber-800",
  confirmed: "bg-blue-100 text-blue-800",
  visited: "bg-green-100 text-green-800",
  cancelled: "bg-gray-200 text-gray-600",
};

export type Reservation = {
  id: string;
  date: string;
  slotId: string;
  slotTime: string;
  planId: string;
  planName: string;
  planMinutes: number;
  lines: { categoryId: string; name: string; unitPrice: number; qty: number }[];
  people: number;
  amount: number;
  customerName: string;
  memo: string;
  status: ReservationStatus;
  source: "staff" | "web";
  /** Web予約の予約番号 */
  code?: string;
};

export type Contact = { phone: string; email: string };

/** キャンセルと、承認前のリクエストは定員に数えない */
export const countsTowardCapacity = (s: ReservationStatus) => s !== "cancelled" && s !== "request";

/** Firestore の変更を即時に受け取るための共通の小道具 */
function useLive<T>(subscribe: ((set: (v: T) => void, fail: (e: unknown) => void) => Promise<() => void>) | null, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!subscribe) return;
    let unsubscribe = () => {};
    let cancelled = false;
    subscribe(setValue, setError).then((u) => (cancelled ? u() : (unsubscribe = u)));
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error };
}

export function useSettings() {
  return useLive<Settings>(async (set, fail) => {
    const { db } = await getFirebase();
    return onSnapshot(doc(db, SETTINGS_DOC), (s) => set(normalizeSettings(s.data() as Partial<Settings> | undefined)), fail);
  }, []);
}

export function useReservations(date: string) {
  return useLive<Reservation[]>(async (set, fail) => {
    const { db } = await getFirebase();
    return onSnapshot(
      query(collection(db, "reservations"), where("date", "==", date)),
      (snap) => set(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Reservation, "id">) }))),
      fail,
    );
  }, [date]);
}

export function useContacts(date: string) {
  return useLive<Record<string, Contact>>(async (set, fail) => {
    const { db } = await getFirebase();
    return onSnapshot(
      query(collection(db, "reservationContacts"), where("date", "==", date)),
      (snap) => set(Object.fromEntries(snap.docs.map((d) => [d.id, d.data() as Contact]))),
      fail,
    );
  }, [date]);
}

/** 承認待ちのリクエスト（今日以降） */
export function usePendingRequests(fromDate: string) {
  return useLive<Reservation[]>(async (set, fail) => {
    const { db } = await getFirebase();
    return onSnapshot(
      query(collection(db, "reservations"), where("status", "==", "request")),
      (snap) =>
        set(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Reservation, "id">) }))
            .filter((r) => r.date >= fromDate)
            .sort((a, b) => (a.date + a.slotTime).localeCompare(b.date + b.slotTime)),
        ),
      fail,
    );
  }, [fromDate]);
}

/** 時間枠ごとの予約人数（空き状況） */
export function useAvailability(date: string | null) {
  return useLive<Record<string, number>>(
    date
      ? async (set, fail) => {
          const { db } = await getFirebase();
          return onSnapshot(doc(db, `availability/${date}`), (s) => set((s.get("slots") as Record<string, number>) ?? {}), fail);
        }
      : null,
    [date],
  );
}

/** この日だけの定員（時間枠ID → 人数）。設定されていない枠は含まない */
export function useDailyCapacity(date: string | null) {
  return useLive<Record<string, number>>(
    date
      ? async (set, fail) => {
          const { db } = await getFirebase();
          return onSnapshot(doc(db, `dailyCapacity/${date}`), (s) => set((s.get("slots") as Record<string, number>) ?? {}), fail);
        }
      : null,
    [date],
  );
}

/** Web予約の受付を止めている時間枠（時間枠ID → true） */
export function useWebStopped(date: string | null) {
  return useLive<Record<string, boolean>>(
    date
      ? async (set, fail) => {
          const { db } = await getFirebase();
          return onSnapshot(doc(db, `dailyCapacity/${date}`), (s) => set((s.get("stopped") as Record<string, boolean>) ?? {}), fail);
        }
      : null,
    [date],
  );
}

/** その日の定員：この日だけの定員があればそれ、なければ設定画面の定員 */
export function capacityOf(settings: Settings, daily: Record<string, number> | null | undefined, slotId: string): number | undefined {
  return daily?.[slotId] ?? settings.timeSlots.find((t) => t.id === slotId)?.capacity;
}

export function peopleText(r: Pick<Reservation, "lines">): string {
  return r.lines.map((l) => `${l.name}${l.qty}`).join("・");
}

export const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
